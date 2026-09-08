//! Dot-matrix orca pod simulation.
//!
//! The whole simulation lives on the Rust side: dot sampling, the swimming
//! traveling wave, drift and wrap-around. JavaScript only reads the packed
//! particle buffer (x, y, size, shade, alpha per dot) out of linear memory
//! once per frame and blits it to a canvas.

use wasm_bindgen::prelude::*;

/// Floats per dot in the shared buffer: x, y, size, shade, alpha.
const FLOATS_PER_DOT: usize = 5;

const TAU: f32 = std::f32::consts::TAU;

// Shade codes resolved to theme colors on the JS side.
const SHADE_BODY: f32 = 0.0;
const SHADE_SADDLE: f32 = 0.45;
const SHADE_SPECK: f32 = 0.62;
const SHADE_PATCH: f32 = 1.0;

/// Deterministic 32-bit LCG so a given seed always builds the same pod.
struct Lcg(u32);

impl Lcg {
    fn new(seed: u32) -> Self {
        Lcg(seed.wrapping_mul(2654435761).wrapping_add(1))
    }

    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.0 >> 8) as f32 / 16_777_216.0
    }

    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next()
    }
}

// --- Orca silhouette ------------------------------------------------------
//
// Local coordinates: the orca is 2 units long, head at x = +1.0, fluke tips
// near x = -1.05, dorsal side y > 0. Facing right.

/// Half-height of the torso at a given x. Zero outside the torso range.
fn body_half_width(x: f32) -> f32 {
    if !(-0.85..=1.0).contains(&x) {
        return 0.0;
    }
    if x >= 0.15 {
        // Rounded front half: ellipse from mid-body to snout.
        let u = (x - 0.15) / 0.85;
        0.28 * (1.0 - u * u).max(0.0).sqrt()
    } else {
        // Tapering rear half down to the tail stock.
        let u = (0.15 - x) / 1.0;
        0.28 * (1.0 - u).max(0.0).powf(1.35) + 0.05 * u
    }
}

fn in_flukes(x: f32, y: f32) -> bool {
    // Shear backward so the lobes sweep toward the rear.
    let xs = x + 0.24 * y.abs();
    if !(-1.06..=-0.78).contains(&xs) {
        return false;
    }
    let t = (-0.78 - xs) / 0.28; // 0 at tail stock, 1 at fluke tips
    let spread = 0.05 + 0.34 * t.powf(0.85);
    if y.abs() >= spread {
        return false;
    }
    // Notch between the two lobes at the trailing edge.
    !(t > 0.55 && y.abs() < (t - 0.55) * 0.30)
}

fn in_dorsal(x: f32, y: f32) -> bool {
    // Tall falcate fin: both edges rake backward, the front edge faster,
    // so the tip ends up narrow and hooked over the back.
    let s = (y - 0.16) / 0.58; // 0 at base, 1 at tip
    if !(0.0..=1.0).contains(&s) {
        return false;
    }
    let front = 0.33 - 0.31 * s.powf(1.5);
    let back = -0.05 + 0.06 * s.powf(0.8);
    x > back && x < front
}

fn in_pectoral(x: f32, y: f32) -> bool {
    // Rotated ellipse angled down and back from the chest.
    let dx = x - 0.42;
    let dy = y + 0.30;
    let (sin, cos) = 0.55f32.sin_cos();
    let u = dx * cos - dy * sin;
    let v = dx * sin + dy * cos;
    (u / 0.16) * (u / 0.16) + (v / 0.07) * (v / 0.07) < 1.0
}

fn in_eye_patch(x: f32, y: f32) -> bool {
    let dx = x - 0.63;
    let dy = y - 0.11;
    let (sin, cos) = 0.18f32.sin_cos();
    let u = dx * cos + dy * sin;
    let v = -dx * sin + dy * cos;
    (u / 0.115) * (u / 0.115) + (v / 0.042) * (v / 0.042) < 1.0
}

fn in_saddle(x: f32, y: f32) -> bool {
    let dx = x + 0.10;
    let dy = y - 0.15;
    y > 0.03 && (dx / 0.17) * (dx / 0.17) + (dy / 0.09) * (dy / 0.09) < 1.0
}

/// Returns the shade code for a point inside the orca, or None outside it.
fn orca_shade(x: f32, y: f32) -> Option<f32> {
    let half = body_half_width(x);
    if y.abs() < half {
        if in_eye_patch(x, y) {
            return Some(SHADE_PATCH);
        }
        // White chin and belly along the underside, stopping before the tail.
        if x > -0.55 && y < -0.30 * half {
            return Some(SHADE_PATCH);
        }
        if in_saddle(x, y) {
            return Some(SHADE_SADDLE);
        }
        return Some(SHADE_BODY);
    }
    if in_flukes(x, y) || in_dorsal(x, y) || in_pectoral(x, y) {
        return Some(SHADE_BODY);
    }
    None
}

// --- Simulation entities --------------------------------------------------

struct Dot {
    lx: f32,
    ly: f32,
    shade: f32,
    size: f32,
    phase: f32,
}

struct Orca {
    dots: Vec<Dot>,
    /// Center position as a fraction of viewport width / height.
    fx: f32,
    fy: f32,
    /// Half body length as a fraction of viewport width.
    scale: f32,
    /// Swim speed in viewport widths per second.
    speed: f32,
    /// Tail-beat frequency in Hz and per-orca wave offset.
    wave_hz: f32,
    phase: f32,
    /// Depth haze: distant orcas render dimmer.
    haze: f32,
}

struct Speck {
    fx: f32,
    fy: f32,
    size: f32,
    /// Drift speed in viewport widths per second (negative: drifts left).
    vx: f32,
    phase: f32,
}

fn sample_orca_dots(rng: &mut Lcg, count: usize) -> Vec<Dot> {
    let mut dots = Vec::with_capacity(count);
    while dots.len() < count {
        let x = rng.range(-1.08, 1.02);
        let y = rng.range(-0.44, 0.68);
        if let Some(shade) = orca_shade(x, y) {
            dots.push(Dot {
                lx: x,
                ly: y,
                shade,
                size: rng.range(0.55, 1.0),
                phase: rng.range(0.0, TAU),
            });
        }
    }
    dots
}

// --- Public interface -----------------------------------------------------

#[wasm_bindgen]
pub struct Ocean {
    width: f32,
    height: f32,
    t: f32,
    orcas: Vec<Orca>,
    specks: Vec<Speck>,
    buffer: Vec<f32>,
    rng: Lcg,
}

#[wasm_bindgen]
impl Ocean {
    #[wasm_bindgen(constructor)]
    pub fn new(width: f32, height: f32, seed: u32) -> Ocean {
        let mut rng = Lcg::new(seed);

        // A small pod: lead orca up close, two companions further away.
        let plan: [(usize, f32, f32, f32, f32, f32, f32); 3] = [
            // dots, fx, fy, scale, speed, wave_hz, haze
            (900, 0.28, 0.30, 0.115, 0.026, 0.55, 1.0),
            (550, 0.72, 0.62, 0.080, 0.033, 0.70, 0.78),
            (340, -0.15, 0.76, 0.054, 0.029, 0.85, 0.55),
        ];
        let orcas = plan
            .iter()
            .map(|&(count, fx, fy, scale, speed, wave_hz, haze)| Orca {
                dots: sample_orca_dots(&mut rng, count),
                fx,
                fy,
                scale,
                speed,
                wave_hz,
                phase: rng.range(0.0, TAU),
                haze,
            })
            .collect::<Vec<_>>();

        let specks = (0..140)
            .map(|_| Speck {
                fx: rng.range(0.0, 1.0),
                fy: rng.range(0.0, 1.0),
                size: rng.range(0.35, 0.95),
                vx: -rng.range(0.004, 0.016),
                phase: rng.range(0.0, TAU),
            })
            .collect::<Vec<_>>();

        let dot_count =
            orcas.iter().map(|o| o.dots.len()).sum::<usize>() + specks.len();

        let mut ocean = Ocean {
            width: width.max(1.0),
            height: height.max(1.0),
            t: 0.0,
            orcas,
            specks,
            buffer: vec![0.0; dot_count * FLOATS_PER_DOT],
            rng,
        };
        ocean.tick(0.0);
        ocean
    }

    pub fn resize(&mut self, width: f32, height: f32) {
        self.width = width.max(1.0);
        self.height = height.max(1.0);
    }

    /// Compose a calm static scene, used when the viewer prefers reduced motion.
    pub fn settle(&mut self) {
        let spots = [(0.30, 0.32), (0.68, 0.58), (0.12, 0.78)];
        for (orca, &(fx, fy)) in self.orcas.iter_mut().zip(spots.iter()) {
            orca.fx = fx;
            orca.fy = fy;
        }
        self.tick(0.0);
    }

    /// Advance the simulation and repack the particle buffer.
    pub fn tick(&mut self, dt: f32) {
        self.t += dt;
        let (w, h) = (self.width, self.height);
        let t = self.t;
        let mut i = 0;

        for orca in &mut self.orcas {
            // Half body length in px, kept legible on any viewport.
            let l = (orca.scale * w).clamp(64.0, 300.0);

            orca.fx += orca.speed * dt;
            if orca.fx * w - 1.35 * l > w {
                // Fully past the right edge: rejoin from the left at a new depth.
                orca.fx = -(1.45 * l) / w;
                orca.fy = self.rng.range(0.15, 0.85);
            }

            let cx = orca.fx * w;
            let cy = orca.fy * h + 0.014 * h * (t * 0.35 + orca.phase).sin();
            let beat = t * orca.wave_hz * TAU + orca.phase;
            let dot_px = 0.9 + l * 0.009;

            for dot in &orca.dots {
                // Traveling wave down the spine; amplitude grows toward the tail.
                let amp = 0.015 + 0.075 * (0.25 - dot.lx).max(0.0).powf(1.4);
                let wave = amp * (2.4 * dot.lx - beat).sin();
                let sx = cx + dot.lx * l;
                let sy = cy - (dot.ly + wave) * l;
                let alpha = orca.haze
                    * (0.62 + 0.22 * (t * 1.6 + dot.phase).sin().abs());

                self.buffer[i] = sx;
                self.buffer[i + 1] = sy;
                self.buffer[i + 2] = dot.size * dot_px;
                self.buffer[i + 3] = dot.shade;
                self.buffer[i + 4] = alpha;
                i += FLOATS_PER_DOT;
            }
        }

        for speck in &mut self.specks {
            speck.fx += speck.vx * dt;
            if speck.fx < -0.02 {
                speck.fx += 1.04;
            }
            let sy = (speck.fy + 0.006 * (t * 0.3 + speck.phase).sin()) * h;
            let alpha = 0.10 + 0.16 * (0.5 + 0.5 * (t * 0.7 + speck.phase).sin());

            self.buffer[i] = speck.fx * w;
            self.buffer[i + 1] = sy;
            self.buffer[i + 2] = speck.size;
            self.buffer[i + 3] = SHADE_SPECK;
            self.buffer[i + 4] = alpha;
            i += FLOATS_PER_DOT;
        }
    }

    /// Pointer into linear memory; JS builds a Float32Array view over it.
    pub fn particles_ptr(&self) -> *const f32 {
        self.buffer.as_ptr()
    }

    /// Total number of f32 values in the particle buffer.
    pub fn particles_len(&self) -> usize {
        self.buffer.len()
    }

    pub fn dot_count(&self) -> usize {
        self.buffer.len() / FLOATS_PER_DOT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silhouette_has_expected_regions() {
        // Mid-torso is black, chin is white, saddle is gray, open water empty.
        assert_eq!(orca_shade(0.2, 0.05), Some(SHADE_BODY));
        assert_eq!(orca_shade(0.7, -0.12), Some(SHADE_PATCH));
        assert_eq!(orca_shade(-0.10, 0.10), Some(SHADE_SADDLE));
        assert_eq!(orca_shade(0.0, 0.9), None);
        assert_eq!(orca_shade(-1.2, 0.0), None);
        // Dorsal fin rises well above the torso line.
        assert_eq!(orca_shade(0.1, 0.5), Some(SHADE_BODY));
        // Fluke lobes exist, the notch between them does not.
        assert_eq!(orca_shade(-1.0, 0.2), Some(SHADE_BODY));
        assert_eq!(orca_shade(-1.05, 0.0), None);
    }

    #[test]
    fn buffer_stays_finite_and_sized() {
        let mut ocean = Ocean::new(1280.0, 800.0, 42);
        for _ in 0..600 {
            ocean.tick(1.0 / 60.0);
        }
        assert_eq!(ocean.particles_len(), ocean.dot_count() * FLOATS_PER_DOT);
        assert!(ocean.buffer.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn sampling_is_deterministic() {
        let a = Ocean::new(1000.0, 600.0, 7);
        let b = Ocean::new(1000.0, 600.0, 7);
        assert_eq!(a.buffer, b.buffer);
    }
}
