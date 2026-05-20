# Jukebox Performance Plan

A prioritized inventory of the renderer's current cost centers and a tiered roadmap to fix them, with rough impact estimates per item. Tiers go from "an afternoon's work, huge mobile wins" to "rewrite a subsystem". Pick what's worth it for the headroom you need.

---

## Where the budget is going right now

A medium-sized deck (≈300 tracks, ROWS=10, COLS=32) produces approximately:

| Cost center | Count | Per-frame cost |
| --- | ---: | --- |
| **Mesh draw calls — cards** | ~320 | one draw per card |
| **Mesh draw calls — brackets** | ~96 | base + chrome pipe/spine per col |
| **Mesh draw calls — ring torii** | ROWS+1 | inter-row dividers |
| **Mesh draw calls — category labels** | COLS | one per column |
| **Mesh draw calls — chrome / rims / glass / neon / floor** | ~10 | one-shot static |
| **Tracker LED spheres + PointLights** | 4 | 4 lights orbiting |
| **DirectionalLight (shadow-casting)** | 1 | renders the scene a 2nd time at 2048² |
| **MeshStandardMaterial users** | ~all | full PBR fragment shader per pixel |
| **PointLights affecting Standard mats** | 6 (2 main + 4 tracker) | shader cost grows per-light |

Approximate per-frame draw calls: **~430 + 4 lights/trackers + 1 shadow pass = ~430 draws × 2 with shadow.**

Mobile GPUs (A14 / Snapdragon 8 Gen 2) start choking past ~500 draw calls. iPhones throttle hard when the shadow map is sampled by every Standard material.

A 1000-track deck pushes this past **1000 draw calls per frame**.

---

## Tier 1 — Quick wins (1–2 hours, very high mobile impact)

These are mostly one-liners. Do all of them first.

### 1.1 Detect mobile / capability and downgrade settings

```ts
const isMobile = /iPad|iPhone|Android/.test(navigator.userAgent) ||
                 (navigator.maxTouchPoints > 1 && screen.width < 1400);
```

Use this flag to gate the rest of the tier-1 changes.

### 1.2 Cap pixel ratio more aggressively on mobile

Currently `Math.min(devicePixelRatio, 2)` → an iPhone 15 at DPR 3 → 2× pixels which means 4× fragment cost. Drop to `1` or `1.5` on mobile.

**Impact:** ~2× fragment shader throughput. Single biggest mobile win.

```ts
renderer.setPixelRatio(isMobile ? 1 : Math.min(devicePixelRatio, 2));
```

### 1.3 Smaller shadow map (or off) on mobile

Currently 2048² PCFSoft. On mobile use 512² Basic, or just disable shadows.

```ts
if (isMobile) {
  renderer.shadowMap.enabled = false;
} else {
  renderer.shadowMap.type = THREE.PCFShadowMap; // not PCFSoft
  dirLight.shadow.mapSize.set(1024, 1024);
}
```

**Impact:** No shadow pass = drop one full scene render per frame. ~30–40% gain on a shadow-heavy frame.

### 1.4 Cull back-of-drum cards

Cards on the far side of the drum are still drawn (backface cull helps but they're still in the visibility pipeline). Hide cards whose `world theta` is more than ~110° from camera azimuth:

```ts
// In animate, after worldSpinAngle update:
const limit = Math.cos(110 * Math.PI / 180);  // -0.34
for (const c of cards) {
  const t = c.userData.theta + jukeboxGroup.rotation.y;
  c.visible = Math.cos(t - CAMERA_AZ) > limit;
}
```

**Impact:** Halves the per-frame card draw call count. Combine with InstancedMesh in Tier 2 for compounding gains.

### 1.5 Conditional `cards.forEach` for emissive

The animate loop currently runs `cards.forEach((c) => c.material.emissiveIntensity += ...)` every frame, even when nothing has changed. With 1000 cards that's a non-trivial JS overhead.

```ts
if (activeCard !== lastActiveCard || emissiveSettling) {
  cards.forEach(...)
}
```

**Impact:** A few ms of main-thread time on big decks, more on slow CPUs.

### 1.6 Lower ring torus segment count

`TorusGeometry(R+0.08, 0.1, 16, 64)` — 16 radial × 64 tubular = 1024 verts per ring. ROWS+1 rings = ~11K verts just for the row dividers. Drop to `8, 32` → 256 verts each (4× fewer).

**Impact:** Tiny but free.

### 1.7 Disable antialias on mobile

`{ antialias: !isMobile }`. AA is FSAA-equivalent, expensive on tile-based mobile GPUs.

**Impact:** ~15–20% fragment shader throughput on mobile.

### 1.8 No texture anisotropy on mobile

`texture.anisotropy = isMobile ? 1 : maxAniso`. Anisotropic filtering is 4–16 extra texture samples per pixel.

**Impact:** Noticeable when the camera is at glancing angles to the cards (which is most of the time).

---

## Tier 2 — Structural wins (1–2 days, big mobile gains)

### 2.1 Convert cards to InstancedMesh + texture atlas

**This is the single biggest performance change available.**

Today: 320–1000 separate `THREE.Mesh + MeshStandardMaterial + CanvasTexture`. Each pair = one draw call, one material upload, one texture bind. iPhone GPUs cap out around 500 draw calls per frame regardless of complexity.

Plan:
1. Pack all card textures into atlases (e.g., 4096² holds ~256 cards at 256×100). 1000 cards → 4 atlases.
2. Use `THREE.InstancedMesh(planeGeo, sharedMaterial, COUNT)` per atlas.
3. Per-instance attributes: UV offset/scale (which slice of the atlas) and color tint (for the emissive highlight on the playing card).

Result: **1000 draw calls → 4 draw calls.** The single largest perf cliff this app has.

Shader: a custom `MeshStandardMaterial` (extend with `onBeforeCompile`) that reads instance UV offset to address the atlas region.

**Impact:** 5–20× FPS on big decks on mobile. Card flips (active highlight, queue replacement) become a texture-region rewrite instead of a material swap.

### 2.2 InstancedMesh for brackets

Same pattern. 32 cols × 2 sub-meshes (base + spine/pipes) = 64 draw calls today. → 2 instanced meshes = 2 draw calls. Trivial because all brackets share the same geometry.

**Impact:** Modest absolute count, but every draw call counts under the 500 ceiling.

### 2.3 Switch most materials from `Standard` to `Lambert`

`MeshStandardMaterial` runs a full PBR shader (Cook-Torrance specular, indirect lighting, roughness/metalness math). Cards are matte paper — they don't need any of that. Lambert is ~3× cheaper per fragment.

Keep `Standard` only for:
- Chrome (gold rims, brackets' chrome accents) — needs metalness/roughness
- The glass shell — needs `MeshPhysicalMaterial` for clearcoat
- Aluminum brackets with normal map — needs Standard for normal map sampling

Everything else (cards, category labels, drum cylinder, brushed-metal-without-normal-map parts) → Lambert.

**Impact:** 30–50% fragment shader cost reduction on the cards alone.

### 2.4 Bake static shadows

The DirectionalLight shadow map is rebuilt every frame for content that almost never changes (the drum/cards' relative positions don't move; the camera position barely moves). Two options:

a) **Throttle shadow updates** — `dirLight.shadow.needsUpdate = false` after the first frame, force `true` when something changes. Drops shadow render cost to near-zero in steady state.
   
b) **Bake an AO texture** into the floor + drum at init time. Then no realtime shadow at all.

Option (a) is simpler and keeps the shadows accurate during goToActiveCard rotations.

**Impact:** ~30% frame time when shadows are on.

### 2.5 Replace per-tracker PointLights with emissive spheres

The 4 tracker LEDs each have a `PointLight` orbiting the rim. Each light recompiles every Standard material's shader (one-time but expensive) and adds per-fragment cost. Replace with:
- Bright emissive spheres (`MeshBasicMaterial` with high color)
- A single glow sprite per tracker (additive blending)

This drops 4 lights without losing the visual.

**Impact:** Shader recompile churn eliminated when the active card changes; ~20% shader cost reduction across all Standard materials.

### 2.6 Category labels as single atlas

Currently each column generates its own 256×64 `CanvasTexture` + Mesh — 32 textures, 32 draws for the same 10 unique strings. Single atlas + InstancedMesh / 10 unique meshes reused, or a single MergedBufferGeometry.

**Impact:** −20-ish draw calls + texture memory savings.

---

## Tier 3 — Architectural (multi-day, future-proofing)

### 3.1 Render at half resolution and CSS-upscale

```ts
renderer.setSize(w / 2, h / 2, false);
renderer.domElement.style.width = w + 'px';
renderer.domElement.style.height = h + 'px';
```

Combined with the chrome/neon aesthetic the slight softness is barely visible. **Halves fragment shader cost wholesale.**

Make it opt-in via the settings modal ("performance mode").

### 3.2 On-demand rendering when truly idle

Currently `requestAnimationFrame` ticks at full rate even when nothing is happening. With the lighting animations (rink color cycles, tracker LEDs orbiting, etc.) something is almost always moving, but during long idle periods this still wastes cycles. Frame-skip when:
- No active card (no LED pulse)
- No spin (no rotation)
- Lighting transition settled
- No drag in progress

Drop to 30 fps or even on-demand. **Battery win more than perf.**

### 3.3 WebGPU renderer

Three.js r170+ ships `THREE.WebGPURenderer` (alongside the existing WebGL one). On Apple Silicon iPads and modern Android, WebGPU is ~2× faster for scenes with many materials and reduces shader recompile cost dramatically — which is exactly our profile.

Cost: requires Three r170+ (we're on 0.184 = fine), some materials need WebGPU-compatible variants, no IE/old-browser support (already irrelevant).

### 3.4 Bake the chrome environment map

The procedural env map texture is a 1024×512 canvas with random colored streaks — generated at init, never updated. It's already optimal as-is, but if you want to switch to a higher-quality look (real HDR studio reflections), use a pre-baked `.hdr` file with `RGBELoader`. Same cost, better look.

### 3.5 Reduce light count to 3–4

The current breakdown:
- HemisphereLight (cheap, always on)
- AmbientLight (cheap, no-position)
- DirectionalLight (the diner ceiling key) — needed
- DirectionalLight (cameraLight / headlight) — could merge with the above
- PointLight × 2 (cyan + magenta rink tubes) — needed for the rink look
- DirectionalLight × 3 (fillWhite, fillAmber, fillPink) — could bake into env map
- DirectionalLight (fillFrontAmber) — could bake or remove
- PointLight × 4 (trackers) — kill per 2.5
- (+ shadow on the diner key)

Target end-state: hemi + ambient + 1 dir + 2 point = 5 lights. **Big shader recompile + per-fragment cost win.**

---

## Suggested rollout order

1. **Today (1 hour):** Tier 1 in entirety. Especially items 1.1–1.4. Should immediately make mobile playable on 500+ track decks.
2. **This week (1 day):** Tier 2.1 (InstancedMesh + atlas for cards) is the marquee. Everything else in Tier 2 takes < 1 hour individually.
3. **Future:** Tier 3 once the visual baseline is locked. The half-res render + WebGPU one-two punch would let the app run at 60fps on a 2020-era phone with a 5000-track deck.

---

## Measurement before / after

Wire up the Chrome DevTools Performance panel and capture:
- **Scripting time** — should drop with 1.5 (skip emissive forEach)
- **Rendering time** — should drop with 1.2 (pixel ratio), 1.3 (shadows), 1.7 (AA), 2.3 (Lambert)
- **GPU time** (when available, requires `?enable-features=WebGLGPUTimeQuery`) — drops with everything above

Or expose an in-app FPS meter:

```ts
let f = 0, lastT = performance.now();
function tickFps() {
  f++;
  const now = performance.now();
  if (now - lastT >= 1000) {
    console.info('fps:', f);
    f = 0; lastT = now;
  }
}
```

Call from `animate()`. Compare baseline vs each change.

---

## What NOT to optimize

- **Card art generation** — runs once at init, async-fast. Adds ~200 ms of CPU on 500 tracks. Not in the per-frame budget.
- **CanvasTexture creation** — only happens at scene init / row count change. Not a per-frame issue.
- **OrbitControls damping** — negligible.
- **Pointer event handlers** — fire at 60 Hz max under user input, do almost nothing.

Focus the work on what runs every frame for every pixel: shaders, lights, draw calls.
