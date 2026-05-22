//! Selection chime (C4/E4/G4) + pink-noise hum via AVAudioEngine.

use std::cell::RefCell;
use std::sync::{Mutex, OnceLock};

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_avf_audio::{
    AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer, AVAudioPlayerNode,
    AVAudioPlayerNodeBufferOptions,
};

static ENABLED: OnceLock<Mutex<bool>> = OnceLock::new();

thread_local! {
    static GRAPH: RefCell<Option<AudioGraph>> = RefCell::new(None);
}

const SAMPLE_RATE: f64 = 44100.0;
const CHIME_FRAMES: u32 = 22050; // ~0.5s
const HUM_FRAMES: u32 = 44100; // 1s loop

// C4, E4, G4
const CHIME_HZ: [f64; 3] = [261.626, 329.628, 391.995];

struct PinkState {
    b0: f32,
    b1: f32,
    b2: f32,
    b3: f32,
    b4: f32,
    b5: f32,
    b6: f32,
}

impl PinkState {
    fn sample(&mut self) -> f32 {
        let white = pseudo_white();
        self.b0 = 0.99886 * self.b0 + white * 0.0555179;
        self.b1 = 0.99332 * self.b1 + white * 0.0750759;
        self.b2 = 0.96900 * self.b2 + white * 0.1538520;
        self.b3 = 0.86650 * self.b3 + white * 0.3104856;
        self.b4 = 0.55000 * self.b4 + white * 0.5329522;
        self.b5 = -0.7616 * self.b5 - white * 0.0168980;
        self.b6 = white * 0.5362;
        self.b0 + self.b1 + self.b2 + self.b3 + self.b4 + self.b5 + self.b6
    }
}

static PINK_SEED: Mutex<u32> = Mutex::new(0xC0FFEE_u32);

fn pseudo_white() -> f32 {
    let mut s = PINK_SEED.lock().unwrap();
    *s = s.wrapping_mul(1664525).wrapping_add(1013904223);
    (*s as f32 / u32::MAX as f32) * 2.0 - 1.0
}

struct AudioGraph {
    #[allow(dead_code)]
    engine: Retained<AVAudioEngine>,
    chime: Retained<AVAudioPlayerNode>,
    hum: Retained<AVAudioPlayerNode>,
    format: Retained<AVAudioFormat>,
    #[allow(dead_code)]
    hum_buffer: Retained<AVAudioPCMBuffer>,
}

impl AudioGraph {
    fn new() -> Option<Self> {
        unsafe {
            let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(
                AVAudioFormat::alloc(),
                SAMPLE_RATE,
                1,
            )?;

            let engine = AVAudioEngine::new();
            let chime = AVAudioPlayerNode::new();
            let hum = AVAudioPlayerNode::new();

            engine.attachNode(&chime);
            engine.attachNode(&hum);
            let mixer = engine.mainMixerNode();
            engine.connect_to_format(&chime, &mixer, Some(&format));
            engine.connect_to_format(&hum, &mixer, Some(&format));

            let hum_buffer = make_hum_buffer(&format)?;
            hum.scheduleBuffer_atTime_options_completionHandler(
                &hum_buffer,
                None,
                AVAudioPlayerNodeBufferOptions::Loops,
                std::ptr::null_mut(),
            );

            engine.startAndReturnError().ok()?;

            Some(Self {
                engine,
                chime,
                hum,
                format,
                hum_buffer,
            })
        }
    }

    fn play_chime(&self) {
        unsafe {
            if let Some(buf) = make_chime_buffer(&self.format) {
                self.chime
                    .scheduleBuffer_completionHandler(&buf, std::ptr::null_mut());
                if !self.chime.isPlaying() {
                    self.chime.play();
                }
            }
            if !self.hum.isPlaying() {
                self.hum.play();
            }
        }
    }

    fn stop_hum(&self) {
        unsafe {
            if self.hum.isPlaying() {
                self.hum.stop();
            }
        }
    }
}

fn enabled_flag() -> &'static Mutex<bool> {
    ENABLED.get_or_init(|| Mutex::new(true))
}

fn with_graph<F, R>(f: F) -> R
where
    F: FnOnce(&mut Option<AudioGraph>) -> R,
{
    GRAPH.with(|cell| f(&mut cell.borrow_mut()))
}

pub fn set_audio_enabled(enabled: bool) {
    if let Ok(mut e) = enabled_flag().lock() {
        *e = enabled;
    }
    if !enabled {
        with_graph(|g| {
            if let Some(graph) = g.as_ref() {
                graph.stop_hum();
            }
        });
    }
}

pub fn play_selection_sound() {
    let enabled = enabled_flag().lock().map(|e| *e).unwrap_or(true);
    if !enabled {
        return;
    }
    with_graph(|g| {
        if g.is_none() {
            *g = AudioGraph::new();
        }
        if let Some(graph) = g.as_ref() {
            graph.play_chime();
        }
    });
}

fn envelope(t: f32) -> f32 {
    if t < 0.02 {
        return t / 0.02;
    }
    let d = t - 0.02;
    if d < 0.2 {
        return 1.0 - d * 0.4;
    }
    if d < 0.5 {
        return 0.92 * (1.0 - (d - 0.2) / 0.3);
    }
    0.0
}

unsafe fn fill_buffer_samples(
    buffer: &AVAudioPCMBuffer,
    frames: u32,
    mut fill: impl FnMut(u32) -> f32,
) {
    buffer.setFrameLength(frames);
    let ch_ptr = buffer.floatChannelData();
    if ch_ptr.is_null() {
        return;
    }
    let samples = (*ch_ptr).as_ptr();
    let out = std::slice::from_raw_parts_mut(samples, frames as usize);
    let mut i = 0;
    while i < frames {
        out[i as usize] = fill(i);
        i += 1;
    }
}

unsafe fn make_chime_buffer(format: &AVAudioFormat) -> Option<Retained<AVAudioPCMBuffer>> {
    let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
        AVAudioPCMBuffer::alloc(),
        format,
        CHIME_FRAMES,
    )?;
    fill_buffer_samples(&buffer, CHIME_FRAMES, |i| {
        let t = i as f64 / SAMPLE_RATE;
        let env = envelope(t as f32);
        let mut sum = 0.0f32;
        let mut k = 0;
        while k < CHIME_HZ.len() {
            let phase = (t * CHIME_HZ[k] * std::f64::consts::TAU).sin();
            sum += (phase as f32) / 3.0;
            k += 1;
        }
        sum * env * 0.28
    });
    Some(buffer)
}

unsafe fn make_hum_buffer(format: &AVAudioFormat) -> Option<Retained<AVAudioPCMBuffer>> {
    let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
        AVAudioPCMBuffer::alloc(),
        format,
        HUM_FRAMES,
    )?;
    let mut pink = PinkState {
        b0: 0.0,
        b1: 0.0,
        b2: 0.0,
        b3: 0.0,
        b4: 0.0,
        b5: 0.0,
        b6: 0.0,
    };
    fill_buffer_samples(&buffer, HUM_FRAMES, |_| pink.sample() * 0.055);
    Some(buffer)
}
