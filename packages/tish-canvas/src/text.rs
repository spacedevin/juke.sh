//! Font cache + glyph rasterization for canvas `fillText` / `strokeText`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use fontdue::Font;

static FONT_CACHE: LazyLock<Mutex<HashMap<String, Arc<Font>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static DEFAULT_FONT: LazyLock<Arc<Font>> = LazyLock::new(|| {
    Arc::new(
        Font::from_bytes(
            include_bytes!("../assets/Fallback-Regular.ttf").as_slice(),
            fontdue::FontSettings::default(),
        )
        .expect("fallback font"),
    )
});

#[derive(Clone, Debug)]
pub struct ParsedFont {
    pub size: f64,
    pub family: String,
    pub bold: bool,
}

pub struct ResolvedFont {
    pub font: Arc<Font>,
    pub synthetic_bold: bool,
}

pub fn parse_font(font: &str) -> ParsedFont {
    let mut size = 10.0;
    let mut family = "sans-serif".to_string();
    let mut bold = false;
    let mut family_parts: Vec<String> = Vec::new();
    for part in split_font_tokens(font) {
        if part == "bold" {
            bold = true;
        } else if part.ends_with("px") {
            if let Ok(n) = part.trim_end_matches("px").parse::<f64>() {
                size = n;
            }
        } else if !part.is_empty() {
            family_parts.push(normalize_family(&part));
        }
    }
    if !family_parts.is_empty() {
        family = family_parts.join(" ");
    }
    ParsedFont { size, family, bold }
}

fn split_font_tokens(font: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote: Option<char> = None;
    for ch in font.chars() {
        match in_quote {
            Some(q) => {
                if ch == q {
                    in_quote = None;
                    if !cur.is_empty() {
                        out.push(cur.clone());
                        cur.clear();
                    }
                } else {
                    cur.push(ch);
                }
            }
            None => {
                if ch == '\'' || ch == '"' {
                    if !cur.is_empty() {
                        out.push(cur.clone());
                        cur.clear();
                    }
                    in_quote = Some(ch);
                } else if ch.is_whitespace() {
                    if !cur.is_empty() {
                        out.push(cur.clone());
                        cur.clear();
                    }
                } else {
                    cur.push(ch);
                }
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub fn normalize_family(raw: &str) -> String {
    raw.trim_matches('"').trim_matches('\'').trim().to_string()
}

fn cache_key(family: &str, bold: bool) -> String {
    format!("{family}:{}", if bold { "bold" } else { "regular" })
}

fn file_slug(family: &str) -> String {
    family
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
}

fn candidate_stems(family: &str, bold: bool) -> Vec<String> {
    let slug = file_slug(family);
    let mut names = vec![
        slug.clone(),
        format!("{slug}-Regular"),
        family.to_string(),
        format!("{family}-Regular"),
    ];
    if bold {
        names.insert(0, format!("{slug}-Bold"));
        names.insert(1, format!("{family}-Bold"));
    }
    names
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn bundle_font_path(stem: &str) -> Option<PathBuf> {
    use objc2_foundation::{NSBundle, NSString};

    let bundle = NSBundle::mainBundle();
    let name = NSString::from_str(stem);
    let ext = NSString::from_str("ttf");
    let dir = NSString::from_str("Fonts");
    let path = bundle.pathForResource_ofType_inDirectory(
        Some(&name),
        Some(&ext),
        Some(&dir),
    )?;
    Some(PathBuf::from(path.to_string()))
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn bundle_font_path(_stem: &str) -> Option<PathBuf> {
    None
}

fn load_font_from_path(path: &Path) -> Option<Arc<Font>> {
    let bytes = fs::read(path).ok()?;
    let font = Font::from_bytes(bytes, fontdue::FontSettings::default()).ok()?;
    Some(Arc::new(font))
}

pub fn load_font_spec(spec: &str) -> bool {
    let parsed = parse_font(spec);
    let _ = resolve_font(&parsed);
    true
}

pub fn load_family(family: &str, bold: bool) -> Option<Arc<Font>> {
    let family = normalize_family(family);
    if family.is_empty() || family == "sans-serif" {
        return Some(DEFAULT_FONT.clone());
    }

    let key = cache_key(&family, bold);
    if let Some(hit) = FONT_CACHE.lock().unwrap().get(&key).cloned() {
        return Some(hit);
    }

    for stem in candidate_stems(&family, bold) {
        if let Some(path) = bundle_font_path(&stem) {
            if let Some(font) = load_font_from_path(&path) {
                FONT_CACHE.lock().unwrap().insert(key, font.clone());
                return Some(font);
            }
        }
    }

    if let Ok(dir) = std::env::var("TISH_FONTS_DIR") {
        let dir = PathBuf::from(dir);
        for stem in candidate_stems(&family, bold) {
            let path = dir.join(format!("{stem}.ttf"));
            if let Some(font) = load_font_from_path(&path) {
                FONT_CACHE.lock().unwrap().insert(key, font.clone());
                return Some(font);
            }
        }
    }

    if bold {
        if let Some(reg) = load_family(&family, false) {
            FONT_CACHE.lock().unwrap().insert(key, reg.clone());
            return Some(reg);
        }
    }

    None
}

pub fn resolve_font(parsed: &ParsedFont) -> ResolvedFont {
    let regular = load_family(&parsed.family, false);
    let font = if parsed.bold {
        load_family(&parsed.family, true)
    } else {
        regular.clone()
    };
    let font = font.unwrap_or_else(|| DEFAULT_FONT.clone());
    let synthetic_bold = parsed.bold
        && regular
            .as_ref()
            .map(|r| Arc::ptr_eq(r, &font))
            .unwrap_or(true);
    ResolvedFont {
        font,
        synthetic_bold,
    }
}

pub fn font_for(family: &str, bold: bool) -> Arc<Font> {
    load_family(family, bold).unwrap_or_else(|| DEFAULT_FONT.clone())
}

pub fn measure_text(font: &Font, text: &str, size: f32) -> f64 {
    let mut width = 0.0f32;
    for ch in text.chars() {
        let (metrics, _) = font.rasterize(ch, size);
        width += metrics.advance_width;
    }
    width as f64
}

pub fn measure_text_scaled(
    font: &Font,
    text: &str,
    size: f32,
    max_width: Option<f64>,
) -> f64 {
    let natural = measure_text(font, text, size);
    match max_width {
        Some(mw) if natural > mw && natural > 0.0 => mw,
        _ => natural,
    }
}

fn baseline_y(font: &Font, y: f64, size: f32, baseline: &str) -> f32 {
    let line = font
        .horizontal_line_metrics(size)
        .unwrap_or(fontdue::LineMetrics {
            ascent: size * 0.8,
            descent: size * 0.2,
            line_gap: 0.0,
            new_line_size: size,
        });
    let y = y as f32;
    match baseline {
        "top" | "hanging" => y + line.ascent,
        "middle" => y + (line.descent - line.ascent) / 2.0,
        "bottom" | "ideographic" => y - line.descent,
        _ => y,
    }
}

fn compress_scale(natural_width: f64, max_width: Option<f64>) -> f32 {
    match max_width {
        Some(mw) if natural_width > mw && natural_width > 0.0 => (mw / natural_width) as f32,
        _ => 1.0,
    }
}

fn plot_glyph(
    plot: &mut dyn FnMut(i32, i32, u8, u8, u8, u8),
    metrics: &fontdue::Metrics,
    bitmap: &[u8],
    cursor: f32,
    dy: f32,
    color: (u8, u8, u8, u8),
    scale_x: f32,
    offset_x: f32,
    offset_y: f32,
) {
    let gx = (cursor * scale_x + offset_x).round() as i32 + metrics.xmin;
    let gy = dy.round() as i32 + metrics.ymin + offset_y.round() as i32;
    let alpha = color.3;
    for row in 0..metrics.height {
        for col in 0..metrics.width {
            let a = bitmap[row * metrics.width + col];
            if a == 0 {
                continue;
            }
            let blended = ((a as u16 * alpha as u16) / 255) as u8;
            if blended == 0 {
                continue;
            }
            let px = if scale_x == 1.0 {
                gx + col as i32
            } else {
                (gx as f32 + col as f32 * scale_x).round() as i32
            };
            plot(px, gy + row as i32, color.0, color.1, color.2, blended);
        }
    }
}

pub fn draw_glyphs(
    plot: &mut dyn FnMut(i32, i32, u8, u8, u8, u8),
    font: &Font,
    text: &str,
    x: f64,
    y: f64,
    size: f32,
    align: &str,
    baseline: &str,
    color: (u8, u8, u8, u8),
    max_width: Option<f64>,
    synthetic_bold: bool,
) {
    let natural_width = measure_text(font, text, size);
    let scale_x = compress_scale(natural_width, max_width);
    let text_width = natural_width * scale_x as f64;

    let mut dx = x as f32;
    match align {
        "center" => dx -= (text_width as f32) / 2.0,
        "right" | "end" => dx -= text_width as f32,
        _ => {}
    }

    let dy = baseline_y(font, y, size, baseline);
    let mut cursor = dx;

    for ch in text.chars() {
        if ch.is_whitespace() {
            let (metrics, _) = font.rasterize(ch, size);
            cursor += metrics.advance_width * scale_x;
            continue;
        }
        let (metrics, bitmap) = font.rasterize(ch, size);
        plot_glyph(plot, &metrics, &bitmap, cursor, dy, color, scale_x, 0.0, 0.0);
        if synthetic_bold {
            let offset = (size * 0.04).max(1.0);
            plot_glyph(
                plot,
                &metrics,
                &bitmap,
                cursor,
                dy,
                color,
                scale_x,
                offset,
                0.0,
            );
        }
        cursor += metrics.advance_width * scale_x;
    }
}

pub fn draw_glyphs_stroke(
    plot: &mut dyn FnMut(i32, i32, u8, u8, u8, u8),
    font: &Font,
    text: &str,
    x: f64,
    y: f64,
    size: f32,
    align: &str,
    baseline: &str,
    color: (u8, u8, u8, u8),
    max_width: Option<f64>,
    line_width: f64,
    synthetic_bold: bool,
) {
    let radius = (line_width / 2.0).ceil().max(1.0) as i32;
    let natural_width = measure_text(font, text, size);
    let scale_x = compress_scale(natural_width, max_width);
    let text_width = natural_width * scale_x as f64;

    let mut dx = x as f32;
    match align {
        "center" => dx -= (text_width as f32) / 2.0,
        "right" | "end" => dx -= text_width as f32,
        _ => {}
    }

    let dy = baseline_y(font, y, size, baseline);
    let mut cursor = dx;

    for ch in text.chars() {
        if ch.is_whitespace() {
            let (metrics, _) = font.rasterize(ch, size);
            cursor += metrics.advance_width * scale_x;
            continue;
        }
        let (metrics, bitmap) = font.rasterize(ch, size);
        for oy in -radius..=radius {
            for ox in -radius..=radius {
                if ox == 0 && oy == 0 {
                    continue;
                }
                if (ox * ox + oy * oy) as f64 > (radius * radius) as f64 {
                    continue;
                }
                plot_glyph(
                    plot,
                    &metrics,
                    &bitmap,
                    cursor,
                    dy,
                    color,
                    scale_x,
                    ox as f32,
                    oy as f32,
                );
            }
        }
        plot_glyph(plot, &metrics, &bitmap, cursor, dy, color, scale_x, 0.0, 0.0);
        if synthetic_bold {
            let offset = (size * 0.04).max(1.0);
            plot_glyph(
                plot,
                &metrics,
                &bitmap,
                cursor,
                dy,
                color,
                scale_x,
                offset,
                0.0,
            );
        }
        cursor += metrics.advance_width * scale_x;
    }
}
