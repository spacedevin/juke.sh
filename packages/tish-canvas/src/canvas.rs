//! CPU canvas 2D subset for juke-cards on Apple platforms.

use std::sync::{Arc, Mutex};

use tishlang_core::{ObjectMap, Value, VmRef};

type SharedBackend = Arc<Mutex<CanvasBackend>>;
type SharedCtx = Arc<Mutex<Ctx2D>>;

#[derive(Clone, Copy, Debug, Default)]
struct Rgba {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

#[derive(Clone, Copy, Debug)]
struct Color(Rgba);

impl Color {
    fn parse(s: &str) -> Self {
        let s = s.trim();
        if s.starts_with('#') {
            let hex = &s[1..];
            let (r, g, b) = match hex.len() {
                3 => {
                    let r = u8::from_str_radix(&hex[0..1].repeat(2), 16).unwrap_or(0);
                    let g = u8::from_str_radix(&hex[1..2].repeat(2), 16).unwrap_or(0);
                    let b = u8::from_str_radix(&hex[2..3].repeat(2), 16).unwrap_or(0);
                    (r, g, b)
                }
                6 | 8 => {
                    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(0);
                    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
                    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
                    (r, g, b)
                }
                _ => (0, 0, 0),
            };
            return Color(Rgba { r, g, b, a: 255 });
        }
        if let Some(inner) = s.strip_prefix("rgba(").and_then(|x| x.strip_suffix(')')) {
            let parts: Vec<f64> = inner
                .split(',')
                .filter_map(|p| p.trim().parse::<f64>().ok())
                .collect();
            if parts.len() >= 3 {
                let a = parts.get(3).copied().unwrap_or(1.0);
                return Color(Rgba {
                    r: parts[0].round().clamp(0.0, 255.0) as u8,
                    g: parts[1].round().clamp(0.0, 255.0) as u8,
                    b: parts[2].round().clamp(0.0, 255.0) as u8,
                    a: (a * 255.0).round().clamp(0.0, 255.0) as u8,
                });
            }
        }
        Color(Rgba {
            r: 0,
            g: 0,
            b: 0,
            a: 255,
        })
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Transform {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Transform {
    fn identity() -> Self {
        Self {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        }
    }

    fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }

    fn translate(&mut self, x: f64, y: f64) {
        self.e += x;
        self.f += y;
    }
}

#[derive(Clone, Debug)]
enum PathSeg {
    Move(f64, f64),
    Line(f64, f64),
    Quad(f64, f64, f64, f64),
    Cubic(f64, f64, f64, f64, f64, f64),
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompositeOp {
    SourceOver,
    Multiply,
    Screen,
}

#[derive(Clone, Debug)]
struct DrawState {
    transform: Transform,
    path: Vec<PathSeg>,
    path_start: Option<(f64, f64)>,
    stack: Vec<(Transform, Vec<PathSeg>, Option<(f64, f64)>)>,
}

impl Default for DrawState {
    fn default() -> Self {
        Self {
            transform: Transform::identity(),
            path: Vec::new(),
            path_start: None,
            stack: Vec::new(),
        }
    }
}

struct CanvasBackend {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl CanvasBackend {
    fn new(width: u32, height: u32) -> Self {
        let len = (width as usize).saturating_mul(height as usize).saturating_mul(4);
        Self {
            width,
            height,
            pixels: vec![0; len],
        }
    }

    fn resize(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
        let len = (width as usize).saturating_mul(height as usize).saturating_mul(4);
        self.pixels.resize(len, 0);
    }

    fn idx(&self, x: i32, y: i32) -> Option<usize> {
        if x < 0 || y < 0 {
            return None;
        }
        let (x, y) = (x as u32, y as u32);
        if x >= self.width || y >= self.height {
            return None;
        }
        Some(((y * self.width + x) * 4) as usize)
    }

    fn get(&self, x: i32, y: i32) -> Rgba {
        let Some(i) = self.idx(x, y) else {
            return Rgba::default();
        };
        Rgba {
            r: self.pixels[i],
            g: self.pixels[i + 1],
            b: self.pixels[i + 2],
            a: self.pixels[i + 3],
        }
    }

    fn put(&mut self, x: i32, y: i32, c: Rgba) {
        let Some(i) = self.idx(x, y) else {
            return;
        };
        self.pixels[i] = c.r;
        self.pixels[i + 1] = c.g;
        self.pixels[i + 2] = c.b;
        self.pixels[i + 3] = c.a;
    }
}

struct Ctx2D {
    backend: SharedBackend,
    canvas: Value,
    self_obj: Value,
    state: DrawState,
}

fn prop_string(obj: &Value, key: &str) -> Option<String> {
    let Value::Object(o) = obj else {
        return None;
    };
    match o.borrow().strings.get(key)? {
        Value::String(s) => Some(s.to_string()),
        v => Some(v.to_display_string()),
    }
}

fn prop_number(obj: &Value, key: &str, default: f64) -> f64 {
    let Value::Object(o) = obj else {
        return default;
    };
    o.borrow()
        .strings
        .get(key)
        .and_then(|v| v.as_number())
        .unwrap_or(default)
}

fn fill_color(ctx: &Ctx2D) -> Color {
    prop_string(&ctx.self_obj, "fillStyle")
        .map(|s| Color::parse(&s))
        .unwrap_or(Color(Rgba {
            r: 0,
            g: 0,
            b: 0,
            a: 255,
        }))
}

fn stroke_color(ctx: &Ctx2D) -> Color {
    prop_string(&ctx.self_obj, "strokeStyle")
        .map(|s| Color::parse(&s))
        .unwrap_or(Color(Rgba {
            r: 0,
            g: 0,
            b: 0,
            a: 255,
        }))
}

fn global_alpha(ctx: &Ctx2D) -> f64 {
    prop_number(&ctx.self_obj, "globalAlpha", 1.0)
}

fn line_width(ctx: &Ctx2D) -> f64 {
    prop_number(&ctx.self_obj, "lineWidth", 1.0)
}

fn composite_op(ctx: &Ctx2D) -> CompositeOp {
    match prop_string(&ctx.self_obj, "globalCompositeOperation").as_deref() {
        Some("multiply") => CompositeOp::Multiply,
        Some("screen") => CompositeOp::Screen,
        _ => CompositeOp::SourceOver,
    }
}

fn blend(dst: Rgba, src: Rgba, op: CompositeOp, global_alpha: f64) -> Rgba {
    let sa = (src.a as f64 / 255.0) * global_alpha;
    if sa <= 0.0 {
        return dst;
    }
    let da = dst.a as f64 / 255.0;
    let (src_r, src_g, src_b) = (src.r as f64, src.g as f64, src.b as f64);
    let (dst_r, dst_g, dst_b) = (dst.r as f64, dst.g as f64, dst.b as f64);
    let (out_r, out_g, out_b) = match op {
        CompositeOp::SourceOver => (src_r, src_g, src_b),
        CompositeOp::Multiply => (
            src_r * dst_r / 255.0,
            src_g * dst_g / 255.0,
            src_b * dst_b / 255.0,
        ),
        CompositeOp::Screen => (
            255.0 - (255.0 - src_r) * (255.0 - dst_r) / 255.0,
            255.0 - (255.0 - src_g) * (255.0 - dst_g) / 255.0,
            255.0 - (255.0 - src_b) * (255.0 - dst_b) / 255.0,
        ),
    };
    let out_a = sa + da * (1.0 - sa);
    if out_a <= 0.0 {
        return Rgba::default();
    }
    let inv = 1.0 / out_a;
    Rgba {
        r: ((out_r * sa + dst_r * da * (1.0 - sa)) * inv)
            .round()
            .clamp(0.0, 255.0) as u8,
        g: ((out_g * sa + dst_g * da * (1.0 - sa)) * inv)
            .round()
            .clamp(0.0, 255.0) as u8,
        b: ((out_b * sa + dst_b * da * (1.0 - sa)) * inv)
            .round()
            .clamp(0.0, 255.0) as u8,
        a: (out_a * 255.0).round().clamp(0.0, 255.0) as u8,
    }
}

impl Ctx2D {
    fn sync_canvas_pixels(&self) {
        let backend = self.backend.lock().unwrap();
        let arr: Vec<Value> = backend
            .pixels
            .iter()
            .map(|&b| Value::Number(b as f64))
            .collect();
        let pixels = Value::Array(VmRef::new(arr));
        if let Value::Object(obj) = &self.canvas {
            obj.borrow_mut()
                .strings
                .insert(Arc::from("__pixels"), pixels);
            obj.borrow_mut().strings.insert(
                Arc::from("width"),
                Value::Number(backend.width as f64),
            );
            obj.borrow_mut().strings.insert(
                Arc::from("height"),
                Value::Number(backend.height as f64),
            );
        }
    }

    fn plot(&mut self, x: i32, y: i32, color: Rgba) {
        let ga = global_alpha(self);
        let op = composite_op(self);
        let mut backend = self.backend.lock().unwrap();
        let dst = backend.get(x, y);
        let blended = blend(dst, color, op, ga);
        backend.put(x, y, blended);
    }

    fn fill_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let color = fill_color(self).0;
        let x0 = x.floor() as i32;
        let y0 = y.floor() as i32;
        let x1 = (x + w).ceil() as i32;
        let y1 = (y + h).ceil() as i32;
        for py in y0..y1 {
            for px in x0..x1 {
                self.plot(px, py, color);
            }
        }
        self.sync_canvas_pixels();
    }

    fn stroke_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        let lw = line_width(self).max(1.0);
        self.fill_rect(x, y, w, lw);
        self.fill_rect(x, y + h - lw, w, lw);
        self.fill_rect(x, y, lw, h);
        self.fill_rect(x + w - lw, y, lw, h);
    }

    fn flatten_path(&self) -> Vec<(f64, f64)> {
        let mut out = Vec::new();
        let mut cur = (0.0, 0.0);
        for seg in &self.state.path {
            match seg {
                PathSeg::Move(x, y) => {
                    cur = (*x, *y);
                    out.push(cur);
                }
                PathSeg::Line(x, y) => {
                    cur = (*x, *y);
                    out.push(cur);
                }
                PathSeg::Quad(cx, cy, x, y) => {
                    flatten_quad(cur, (*cx, *cy), (*x, *y), &mut out);
                    cur = (*x, *y);
                }
                PathSeg::Cubic(c1x, c1y, c2x, c2y, x, y) => {
                    flatten_cubic(cur, (*c1x, *c1y), (*c2x, *c2y), (*x, *y), &mut out);
                    cur = (*x, *y);
                }
                PathSeg::Close => {
                    if let Some(start) = self.state.path_start {
                        out.push(start);
                        cur = start;
                    }
                }
            }
        }
        out
    }

    fn fill_path(&mut self) {
        let pts: Vec<(f64, f64)> = self
            .flatten_path()
            .into_iter()
            .map(|(x, y)| self.state.transform.apply(x, y))
            .collect();
        if pts.len() < 3 {
            return;
        }
        let color = fill_color(self).0;
        let min_y = pts.iter().map(|p| p.1).fold(f64::INFINITY, f64::min).floor() as i32;
        let max_y = pts.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max).ceil() as i32;

        for y in min_y..=max_y {
            let mut xs = Vec::new();
            let scan = y as f64 + 0.5;
            for i in 0..pts.len() {
                let (x1, y1) = pts[i];
                let (x2, y2) = pts[(i + 1) % pts.len()];
                if (y1 <= scan && y2 > scan) || (y2 <= scan && y1 > scan) {
                    let t = (scan - y1) / (y2 - y1);
                    xs.push(x1 + t * (x2 - x1));
                }
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mut i = 0;
            while i + 1 < xs.len() {
                let x_start = xs[i].floor() as i32;
                let x_end = xs[i + 1].ceil() as i32;
                for x in x_start..x_end {
                    self.plot(x, y, color);
                }
                i += 2;
            }
        }
        self.sync_canvas_pixels();
    }

    fn stroke_path(&mut self) {
        let pts = self.flatten_path();
        if pts.len() < 2 {
            return;
        }
        let lw = line_width(self).max(1.0);
        let color = stroke_color(self).0;
        for w in pts.windows(2) {
            let (x0, y0) = self.state.transform.apply(w[0].0, w[0].1);
            let (x1, y1) = self.state.transform.apply(w[1].0, w[1].1);
            draw_line(self, x0, y0, x1, y1, lw, color);
        }
        self.sync_canvas_pixels();
    }

    fn fill_text(&mut self, text: &str, x: f64, y: f64) {
        let font = prop_string(&self.self_obj, "font").unwrap_or_else(|| "10px sans-serif".into());
        let align = prop_string(&self.self_obj, "textAlign").unwrap_or_else(|| "start".into());
        let baseline = prop_string(&self.self_obj, "textBaseline")
            .unwrap_or_else(|| "alphabetic".into());
        let color = fill_color(self).0;
        let (tx, ty) = self.state.transform.apply(x, y);
        draw_text_simple(self, text, tx, ty, &font, &align, &baseline, color);
        self.sync_canvas_pixels();
    }

    fn draw_image(&mut self, src_canvas: &Value, dx: f64, dy: f64) {
        let Some((sw, sh, src_pixels)) = read_canvas_pixels(src_canvas) else {
            return;
        };
        for sy in 0..sh {
            for sx in 0..sw {
                let i = ((sy * sw + sx) * 4) as usize;
                if i + 3 >= src_pixels.len() {
                    continue;
                }
                let c = Rgba {
                    r: src_pixels[i] as u8,
                    g: src_pixels[i + 1] as u8,
                    b: src_pixels[i + 2] as u8,
                    a: src_pixels[i + 3] as u8,
                };
                self.plot((dx + sx as f64).round() as i32, (dy + sy as f64).round() as i32, c);
            }
        }
        self.sync_canvas_pixels();
    }

    fn get_image_data(&self, x: i32, y: i32, w: u32, h: u32) -> Value {
        let backend = self.backend.lock().unwrap();
        image_data_value(image_data_from_backend(&backend, x, y, w, h), w, h)
    }

    fn put_image_data(&mut self, image_data: &Value, dx: i32, dy: i32) {
        let Some(data) = image_data_array(image_data) else {
            return;
        };
        let w = self.backend.lock().unwrap().width;
        let h = self.backend.lock().unwrap().height;
        for row in 0..h {
            for col in 0..w {
                let i = ((row * w + col) * 4) as usize;
                if i + 3 >= data.len() {
                    continue;
                }
                let c = Rgba {
                    r: data[i] as u8,
                    g: data[i + 1] as u8,
                    b: data[i + 2] as u8,
                    a: data[i + 3] as u8,
                };
                self.plot(dx + col as i32, dy + row as i32, c);
            }
        }
        self.sync_canvas_pixels();
    }

    fn create_image_data(&self, w: u32, h: u32) -> Value {
        let len = (w as usize * h as usize * 4) as usize;
        image_data_value(vec![0.0; len], w, h)
    }
}

fn flatten_quad(p0: (f64, f64), p1: (f64, f64), p2: (f64, f64), out: &mut Vec<(f64, f64)>) {
    flatten_cubic(p0, lerp(p0, p1, 2.0 / 3.0), lerp(p1, p2, 1.0 / 3.0), p2, out);
}

fn lerp(a: (f64, f64), b: (f64, f64), t: f64) -> (f64, f64) {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

fn flatten_cubic(
    p0: (f64, f64),
    p1: (f64, f64),
    p2: (f64, f64),
    p3: (f64, f64),
    out: &mut Vec<(f64, f64)>,
) {
    const FLATNESS: f64 = 0.5;
    fn recur(
        p0: (f64, f64),
        p1: (f64, f64),
        p2: (f64, f64),
        p3: (f64, f64),
        out: &mut Vec<(f64, f64)>,
    ) {
        let d1 = dist_point_line(p1, p0, p3);
        let d2 = dist_point_line(p2, p0, p3);
        if d1 + d2 < FLATNESS {
            out.push(p3);
            return;
        }
        let p01 = lerp(p0, p1, 0.5);
        let p12 = lerp(p1, p2, 0.5);
        let p23 = lerp(p2, p3, 0.5);
        let p012 = lerp(p01, p12, 0.5);
        let p123 = lerp(p12, p23, 0.5);
        let p0123 = lerp(p012, p123, 0.5);
        recur(p0, p01, p012, p0123, out);
        recur(p0123, p123, p23, p3, out);
    }
    recur(p0, p1, p2, p3, out);
}

fn dist_point_line(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    if dx == 0.0 && dy == 0.0 {
        return ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt();
    }
    ((dy * p.0 - dx * p.1 + b.0 * a.1 - b.1 * a.0).abs()) / (dx * dx + dy * dy).sqrt()
}

fn draw_line(ctx: &mut Ctx2D, x0: f64, y0: f64, x1: f64, y1: f64, width: f64, color: Rgba) {
    let steps = ((x1 - x0).abs().max((y1 - y0).abs()) * 2.0).ceil() as i32;
    let hw = (width / 2.0).max(0.5);
    for i in 0..=steps.max(1) {
        let t = i as f64 / steps.max(1) as f64;
        let x = x0 + (x1 - x0) * t;
        let y = y0 + (y1 - y0) * t;
        for oy in (-hw as i32)..=(hw as i32) {
            for ox in (-hw as i32)..=(hw as i32) {
                ctx.plot(x.round() as i32 + ox, y.round() as i32 + oy, color);
            }
        }
    }
}

fn draw_text_simple(
    ctx: &mut Ctx2D,
    text: &str,
    x: f64,
    y: f64,
    font: &str,
    align: &str,
    baseline: &str,
    color: Rgba,
) {
    let (size, _family) = parse_font(font);
    let char_w = size * 0.55;
    let width = text.chars().count() as f64 * char_w;
    let mut dx = x;
    match align {
        "center" => dx -= width / 2.0,
        "right" | "end" => dx -= width,
        _ => {}
    }
    let mut dy = y;
    match baseline {
        "middle" => dy -= size / 2.0,
        "bottom" => dy -= size,
        _ => dy -= size * 0.8,
    }
    for (i, ch) in text.chars().enumerate() {
        if ch.is_whitespace() {
            continue;
        }
        let cx = dx + i as f64 * char_w;
        for py in 0..(size as i32) {
            for px in 0..(char_w as i32) {
                ctx.plot((cx + px as f64).round() as i32, (dy + py as f64).round() as i32, color);
            }
        }
    }
}

fn parse_font(font: &str) -> (f64, String) {
    let mut size = 10.0;
    let mut family = "Helvetica".to_string();
    let mut bold = false;
    for part in font.split_whitespace() {
        if part == "bold" {
            bold = true;
        } else if part.ends_with("px") {
            if let Ok(n) = part.trim_end_matches("px").parse::<f64>() {
                size = n;
            }
        } else if !part.is_empty() {
            family = part.trim_matches('"').to_string();
        }
    }
    if bold {
        family = format!("{} Bold", family);
    }
    (size, family)
}

fn image_data_from_backend(backend: &CanvasBackend, x: i32, y: i32, w: u32, h: u32) -> Vec<f64> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h {
        for col in 0..w {
            let c = backend.get(x + col as i32, y + row as i32);
            out.push(c.r as f64);
            out.push(c.g as f64);
            out.push(c.b as f64);
            out.push(c.a as f64);
        }
    }
    out
}

fn image_data_value(data: Vec<f64>, w: u32, h: u32) -> Value {
    let arr: Vec<Value> = data.iter().map(|&n| Value::Number(n)).collect();
    let mut m = ObjectMap::default();
    m.insert(Arc::from("data"), Value::Array(VmRef::new(arr)));
    m.insert(Arc::from("width"), Value::Number(w as f64));
    m.insert(Arc::from("height"), Value::Number(h as f64));
    Value::object(m)
}

fn image_data_array(v: &Value) -> Option<Vec<f64>> {
    let Value::Object(obj) = v else {
        return None;
    };
    let data = {
        let b = obj.borrow();
        b.strings.get("data")?.clone()
    };
    let Value::Array(arr) = data else {
        return None;
    };
    let values: Vec<f64> = arr
        .borrow()
        .iter()
        .filter_map(|v| v.as_number())
        .collect();
    Some(values)
}

fn read_canvas_pixels(canvas: &Value) -> Option<(u32, u32, Vec<f64>)> {
    let Value::Object(obj) = canvas else {
        return None;
    };
    let m = &obj.borrow().strings;
    let w = m.get("width")?.as_number()? as u32;
    let h = m.get("height")?.as_number()? as u32;
    if let Some(Value::Array(arr)) = m.get("__pixels") {
        return Some((
            w,
            h,
            arr.borrow().iter().filter_map(|v| v.as_number()).collect(),
        ));
    }
    None
}

fn canvas_dims(canvas: &Value) -> (u32, u32) {
    let Value::Object(obj) = canvas else {
        return (300, 150);
    };
    let m = &obj.borrow().strings;
    let w = m
        .get("width")
        .and_then(|v| v.as_number())
        .unwrap_or(300.0)
        .max(1.0) as u32;
    let h = m
        .get("height")
        .and_then(|v| v.as_number())
        .unwrap_or(150.0)
        .max(1.0) as u32;
    (w, h)
}

fn make_canvas_element() -> Value {
    let (w, h) = (300_u32, 150_u32);
    let mut m = ObjectMap::default();
    m.insert(Arc::from("width"), Value::Number(w as f64));
    m.insert(Arc::from("height"), Value::Number(h as f64));
    let canvas = Value::object(m);
    let get_context = {
        let canvas = canvas.clone();
        Value::native(move |args: &[Value]| {
            let _opts = args.get(1);
            let (w, h) = canvas_dims(&canvas);
            let backend = Arc::new(Mutex::new(CanvasBackend::new(w, h)));
            make_context(canvas.clone(), backend)
        })
    };
    if let Value::Object(obj) = &canvas {
        obj.borrow_mut()
            .strings
            .insert(Arc::from("getContext"), get_context);
    }
    canvas
}

fn attach_ctx_methods(m: &mut ObjectMap, shared: SharedCtx) {
    macro_rules! bind {
        ($name:literal, |$g:ident, $args:ident| $body:expr) => {{
            let c = shared.clone();
            m.insert(
                Arc::from($name),
                Value::native(move |$args: &[Value]| {
                    let mut $g = c.lock().unwrap();
                    $body
                }),
            );
        }};
    }

    bind!("fillRect", |g, args| {
        g.fill_rect(num(args, 0), num(args, 1), num(args, 2), num(args, 3));
        Value::Null
    });
    bind!("strokeRect", |g, args| {
        g.stroke_rect(num(args, 0), num(args, 1), num(args, 2), num(args, 3));
        Value::Null
    });
    bind!("beginPath", |g, _args| {
        g.state.path.clear();
        g.state.path_start = None;
        Value::Null
    });
    bind!("moveTo", |g, args| {
        let x = num(args, 0);
        let y = num(args, 1);
        g.state.path.push(PathSeg::Move(x, y));
        g.state.path_start = Some((x, y));
        Value::Null
    });
    bind!("lineTo", |g, args| {
        g.state.path.push(PathSeg::Line(num(args, 0), num(args, 1)));
        Value::Null
    });
    bind!("closePath", |g, _args| {
        g.state.path.push(PathSeg::Close);
        Value::Null
    });
    bind!("quadraticCurveTo", |g, args| {
        g.state.path.push(PathSeg::Quad(num(args, 0), num(args, 1), num(args, 2), num(args, 3)));
        Value::Null
    });
    bind!("bezierCurveTo", |g, args| {
        g.state.path.push(PathSeg::Cubic(
            num(args, 0), num(args, 1), num(args, 2), num(args, 3), num(args, 4), num(args, 5),
        ));
        Value::Null
    });
    bind!("arc", |g, args| {
        arc_to_path(&mut g.state.path, num(args, 0), num(args, 1), num(args, 2), num(args, 3), num(args, 4));
        Value::Null
    });
    bind!("ellipse", |g, args| {
        ellipse_to_path(&mut g.state.path, num(args, 0), num(args, 1), num(args, 2), num(args, 3), num(args, 5), num(args, 6));
        Value::Null
    });
    bind!("fill", |g, _args| { g.fill_path(); Value::Null });
    bind!("stroke", |g, _args| { g.stroke_path(); Value::Null });
    bind!("save", |g, _args| {
        let t = g.state.transform;
        let p = g.state.path.clone();
        let s = g.state.path_start;
        g.state.stack.push((t, p, s));
        Value::Null
    });
    bind!("restore", |g, _args| {
        if let Some((t, p, s)) = g.state.stack.pop() {
            g.state.transform = t;
            g.state.path = p;
            g.state.path_start = s;
        }
        Value::Null
    });
    bind!("translate", |g, args| {
        g.state.transform.translate(num(args, 0), num(args, 1));
        Value::Null
    });
    bind!("rotate", |g, args| {
        let t = num(args, 0);
        let (sin, cos) = t.sin_cos();
        let tr = &mut g.state.transform;
        let (a0, b, c0, d, e, f) = (tr.a, tr.b, tr.c, tr.d, tr.e, tr.f);
        tr.a = a0 * cos + c0 * sin;
        tr.b = b * cos + d * sin;
        tr.c = c0 * cos - a0 * sin;
        tr.d = d * cos - b * sin;
        tr.e = e;
        tr.f = f;
        Value::Null
    });
    bind!("scale", |g, args| {
        let sx = num(args, 0);
        let sy = num_or(args, 1, sx);
        let tr = &mut g.state.transform;
        tr.a *= sx;
        tr.b *= sx;
        tr.c *= sy;
        tr.d *= sy;
        Value::Null
    });
    bind!("fillText", |g, args| {
        let text = args.first().map(|v| v.to_display_string()).unwrap_or_default();
        g.fill_text(&text, num(args, 1), num(args, 2));
        Value::Null
    });
    bind!("strokeText", |g, args| {
        let text = args.first().map(|v| v.to_display_string()).unwrap_or_default();
        g.fill_text(&text, num(args, 1), num(args, 2));
        Value::Null
    });
    bind!("drawImage", |g, args| {
        if let Some(src) = args.first() {
            g.draw_image(src, num(args, 1), num(args, 2));
        }
        Value::Null
    });
    bind!("getImageData", |g, args| {
        g.get_image_data(num(args, 0) as i32, num(args, 1) as i32, num(args, 2) as u32, num(args, 3) as u32)
    });
    bind!("putImageData", |g, args| {
        if let Some(id) = args.first() {
            g.put_image_data(id, num(args, 1) as i32, num(args, 2) as i32);
        }
        Value::Null
    });
    bind!("createImageData", |g, args| {
        g.create_image_data(num(args, 0) as u32, num(args, 1) as u32)
    });
}

fn make_context(canvas: Value, backend: SharedBackend) -> Value {
    let shared_ctx: SharedCtx = Arc::new(Mutex::new(Ctx2D {
        backend,
        canvas: canvas.clone(),
        self_obj: Value::Null,
        state: DrawState::default(),
    }));

    let mut m = ObjectMap::default();
    m.insert(
        Arc::from("fillStyle"),
        Value::String(Arc::from("#000000")),
    );
    m.insert(
        Arc::from("strokeStyle"),
        Value::String(Arc::from("#000000")),
    );
    m.insert(Arc::from("lineWidth"), Value::Number(1.0));
    m.insert(Arc::from("globalAlpha"), Value::Number(1.0));
    m.insert(
        Arc::from("globalCompositeOperation"),
        Value::String(Arc::from("source-over")),
    );
    m.insert(
        Arc::from("font"),
        Value::String(Arc::from("10px sans-serif")),
    );
    m.insert(
        Arc::from("textAlign"),
        Value::String(Arc::from("start")),
    );
    m.insert(
        Arc::from("textBaseline"),
        Value::String(Arc::from("alphabetic")),
    );

    attach_ctx_methods(&mut m, shared_ctx.clone());

    let obj = Value::object(m);
    {
        let mut g = shared_ctx.lock().unwrap();
        g.self_obj = obj.clone();
        g.sync_canvas_pixels();
    }
    obj
}

fn arc_to_path(path: &mut Vec<PathSeg>, cx: f64, cy: f64, r: f64, start: f64, end: f64) {
    let steps = ((end - start).abs() * r / 2.0).ceil().max(8.0) as i32;
    for i in 0..=steps {
        let t = start + (end - start) * (i as f64 / steps as f64);
        let x = cx + t.cos() * r;
        let y = cy + t.sin() * r;
        if i == 0 {
            path.push(PathSeg::Move(x, y));
        } else {
            path.push(PathSeg::Line(x, y));
        }
    }
}

fn ellipse_to_path(
    path: &mut Vec<PathSeg>,
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    start: f64,
    end: f64,
) {
    let steps = ((end - start).abs() * rx.max(ry) / 2.0).ceil().max(8.0) as i32;
    for i in 0..=steps {
        let t = start + (end - start) * (i as f64 / steps as f64);
        let x = cx + t.cos() * rx;
        let y = cy + t.sin() * ry;
        if i == 0 {
            path.push(PathSeg::Move(x, y));
        } else {
            path.push(PathSeg::Line(x, y));
        }
    }
}

fn num(args: &[Value], i: usize) -> f64 {
    args.get(i).and_then(|v| v.as_number()).unwrap_or(0.0)
}

fn num_or(args: &[Value], i: usize, default: f64) -> f64 {
    args.get(i).and_then(|v| v.as_number()).unwrap_or(default)
}

pub fn document_value() -> Value {
    let create_element = Value::native(|args: &[Value]| {
        let tag = args
            .first()
            .map(|v| match v {
                Value::String(s) => s.to_string(),
                v => v.to_display_string(),
            })
            .unwrap_or_default();
        if tag == "canvas" {
            make_canvas_element()
        } else {
            Value::Null
        }
    });
    let mut m = ObjectMap::default();
    m.insert(Arc::from("createElement"), create_element);
    Value::object(m)
}
