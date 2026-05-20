import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { generateCardArt, xmur3 } from '@spacedevin/juke-cards'
import { createToneAudio } from './tone-audio.js'

const TIGHT_FOV_NORMAL = 12
const TIGHT_FOV_FLAT = 2
const MIN_SCENE_ROWS = 4
const MAX_SCENE_ROWS = 20

function clampSceneRows(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 10
  const r = Math.floor(v)
  if (r < MIN_SCENE_ROWS) return MIN_SCENE_ROWS
  if (r > MAX_SCENE_ROWS) return MAX_SCENE_ROWS
  return r
}

function normalizeTracks(tracks) {
  return Array.isArray(tracks) ? tracks : []
}

function spotify() { return window.__jukeSpotify || {} }

function initThree(container, tracks, nowItem, onActiveChange, onPlaybackError, mode, rows) {
  tracks = normalizeTracks(tracks)
  rows = clampSceneRows(rows)
  const { initAudio, disposeAudio, playSelectionSound, bindAudioMode } = createToneAudio(mode)
  bindAudioMode()
  let shuffleInitialized = false;
  mode.setShuffle = (enabled) => {
    if (mode.debug) return;
    void spotify().setShuffle(enabled).catch(() => {});
  };

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0508, 100, 300);
  scene.background = new THREE.Color(0x0a0508);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 5, 60);
  // logarithmicDepthBuffer = much better depth precision across wide ranges.
  // Needed because at max zoomFlat the FOV drops to ~2° → camera pulls back
  // to ~700 units, and the cards-vs-drum 0.03-unit gap z-fights with the
  // standard 24-bit nonlinear depth buffer (the dark drum #111 shows through
  // the cards). Tiny per-pixel shader cost; eliminates the artifact entirely.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // NeutralToneMapping (Three r163+) preserves color saturation much better
  // than ACES, which is famous for desaturating bright colors toward white —
  // exactly the "grayish / dull" look we were getting on saturated cards.
  // Slightly higher exposure pushes midtones up so the rink-mode neon reads
  // more punchy.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  // Take focus immediately so a hardware keyboard's first arrow / C press
  // works without the user having to tap first.
  try { container.focus({ preventScroll: true }); } catch {}

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1; // only affects auto-orbit / damping internals;
                                // drag rotation is handled by us directly below
  controls.minPolarAngle = Math.PI / 2;
  controls.maxPolarAngle = Math.PI / 2;
  controls.enableZoom = false;   // we drive zoom ourselves via mode.zoom
  controls.enablePan = false;    // two-finger drag should never pan the camera
  // CRITICAL: we drive horizontal rotation ourselves (see onPointerMove +
  // momentum coast in animate). OrbitControls' damping pipeline buffered each
  // move event across many frames AND decayed pending input symmetrically,
  // which felt like the drum lagged the finger AND lost momentum on release.
  // Direct camera-azimuth writes make drag pixel-perfect, and we track
  // pointer velocity for a real fling/coast.
  controls.enableRotate = false;

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x333333, 0.5);
  scene.add(hemiLight);
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.0);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffeedd, 0.5);
  dirLight.position.set(0, 20, 30);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 10;
  dirLight.shadow.camera.far = 300;
  dirLight.shadow.camera.left = -40;
  dirLight.shadow.camera.right = 40;
  dirLight.shadow.camera.top = 40;
  dirLight.shadow.camera.bottom = -40;
  dirLight.shadow.bias = -0.001;
  // Manual shadow-map updates. Three.js otherwise re-renders the entire scene
  // into a 2048² depth target every frame. We instead set `needsUpdate = true`
  // only when something that affects the shadow has actually moved (camera
  // azimuth → dirLight repositions; drum rotation → cards move; new card
  // placed). At rest that's a 20-30% frame-time saving with zero visible
  // change — the shadow looks identical because the geometry hasn't moved.
  dirLight.shadow.autoUpdate = false;
  dirLight.shadow.needsUpdate = true; // first frame
  scene.add(dirLight);
  const cameraLight = new THREE.DirectionalLight(0xffffff, 0.0);
  scene.add(cameraLight);
  scene.add(cameraLight.target);
  // Saturated rink lights — the cyan/magenta that wash the drum in rink mode.
  // 2.5 (was 1.2) so they actually punch through against the warm fills.
  const pointLight1 = new THREE.PointLight(0x00ffff, 2.5, 80);
  pointLight1.position.set(-25, 10, 25);
  scene.add(pointLight1);
  const pointLight2 = new THREE.PointLight(0xff00ff, 2.5, 80);
  pointLight2.position.set(25, -10, -25);
  scene.add(pointLight2);

  // Trichromatic fill lights for roller-rink mode — give readable form without
  // a white-out. Modulated by intensity per mode/zoom in animate().
  const fillWhite = new THREE.DirectionalLight(0xffffff, 0.0);
  fillWhite.position.set(0, 30, 50);
  scene.add(fillWhite);
  scene.add(fillWhite.target);
  const fillAmber = new THREE.DirectionalLight(0xffaa55, 0.0);
  fillAmber.position.set(-40, 20, 20);
  scene.add(fillAmber);
  scene.add(fillAmber.target);
  const fillPink = new THREE.DirectionalLight(0xff66cc, 0.0);
  fillPink.position.set(40, 20, 20);
  scene.add(fillPink);
  scene.add(fillPink.target);
  // Amber that orbits with the camera azimuth, lighting the front-facing
  // cards so the center doesn't go black.
  const fillFrontAmber = new THREE.DirectionalLight(0xffaa55, 0.0);
  scene.add(fillFrontAmber);
  scene.add(fillFrontAmber.target);

  // Card grid sized to fit track count. We reserve at least MIN_EMPTY blank
  // slots scattered through the deck; these double as the live queue for
  // incoming now-playing tracks. After reserving empties, round COLS up to
  // even so the alternating teal/aluminum bracket pattern wraps cleanly.
  const ROWS = rows;
  const MIN_EMPTY = 10;
  let COLS = Math.max(8, Math.ceil((tracks.length + MIN_EMPTY) / ROWS));
  if (COLS % 2 === 1) COLS += 1;
  // rotateSpeed is recomputed per-frame in animate() — see updateRotateSpeed —
  // because true 1:1 drag depends on the camera's current distance + FOV,
  // both of which change with `mode.zoom`. A static value can't be both
  // comfortable at fit-zoom AND not whip-past at telephoto zoom.
  const totalCells = COLS * ROWS;
  let emptyCount = totalCells - tracks.length;
  if (emptyCount < 0 || !Number.isFinite(emptyCount)) {
    while (COLS * ROWS < tracks.length + MIN_EMPTY) COLS += 2;
    emptyCount = COLS * ROWS - tracks.length;
  }
  const displayTracks = [...tracks, ...Array(Math.max(0, emptyCount)).fill(null)];
  for (let i = displayTracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [displayTracks[i], displayTracks[j]] = [displayTracks[j], displayTracks[i]];
  }
  const CARD_W = 3.2;
  const CARD_H = 1.25;
  const ROW_SPACING = 1.4;
  const COL_ANGLE = (Math.PI * 2) / COLS;
  const R = (COLS * (CARD_W + 0.3)) / (2 * Math.PI);
  const startY = (ROWS * ROW_SPACING) / 2 - ROW_SPACING / 2;
  const HEIGHT_TOTAL = ROWS * ROW_SPACING + 4;

  const jukeboxGroup = new THREE.Group();
  scene.add(jukeboxGroup);

  // Floor
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = 1024; floorCanvas.height = 1024;
  const fctx = floorCanvas.getContext('2d');
  fctx.fillStyle = '#050505'; fctx.fillRect(0, 0, 1024, 1024);
  fctx.fillStyle = '#e8e8e8';
  for (let i = 0; i < 1024; i += 128) for (let j = 0; j < 1024; j += 128) if ((i / 128 + j / 128) % 2 === 0) fctx.fillRect(i, j, 128, 128);
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.wrapS = THREE.RepeatWrapping; floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(16, 16);
  floorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.1, metalness: 0.4, color: 0xaaaaaa }));
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -HEIGHT_TOTAL / 2 - 3;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // Env map — seeded so chrome reflections are identical across reloads
  const envCanvas = document.createElement('canvas');
  envCanvas.width = 1024; envCanvas.height = 512;
  const envCtx = envCanvas.getContext('2d');
  envCtx.fillStyle = '#050203'; envCtx.fillRect(0, 0, 1024, 512);
  const envSeed = xmur3('jukebox-env');
  const envRnd = () => (envSeed() >>> 0) / 4294967296;
  const envRndInt = (max) => Math.floor(envRnd() * max);
  const envColors = ['#00ffff', '#ff00ff', '#ffffff', '#ffaa00'];
  for (let i = 0; i < 30; i++) {
    envCtx.fillStyle = envColors[envRndInt(envColors.length)];
    envCtx.globalAlpha = 0.2 + envRnd() * 0.8;
    envCtx.fillRect(envRnd() * 1024, envRnd() * 512, 100 + envRnd() * 300, 5 + envRnd() * 20);
  }
  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = envTex;

  // Hardware
  // Procedural brushed-aluminum texture pair (normal + roughness). Vertical
  // streaks of small random horizontal-tilt perturbations + a matching
  // grayscale roughness variation. Cheap, geometry-free milled-metal look.
  function buildBrushedAluminumMaps() {
    const W = 128, H = 512;

    // Normal map — neutral blue base (128, 128, 255) with per-column X-tilt
    const nc = document.createElement('canvas');
    nc.width = W; nc.height = H;
    const nctx = nc.getContext('2d');
    const nimg = nctx.createImageData(W, H);
    for (let x = 0; x < W; x++) {
      // Each vertical streak has a different slight horizontal tilt
      const tilt = (Math.sin(x * 12.9898) * 43758.5453) % 1;
      const r = Math.round(128 + tilt * 30); // X channel
      for (let y = 0; y < H; y++) {
        // Add fine grain noise per pixel for visible scratches
        const grain = (Math.sin(x * 1.7 + y * 0.3) * 2 + Math.sin(y * 5.1) * 1) | 0;
        const i = (y * W + x) * 4;
        nimg.data[i] = Math.max(0, Math.min(255, r + grain));
        nimg.data[i + 1] = 128;       // Y tilt ≈ 0 (no horizontal scratches)
        nimg.data[i + 2] = 250;       // Z (mostly outward)
        nimg.data[i + 3] = 255;
      }
    }
    nctx.putImageData(nimg, 0, 0);
    const normal = new THREE.CanvasTexture(nc);
    normal.wrapS = THREE.RepeatWrapping;
    normal.wrapT = THREE.RepeatWrapping;
    normal.repeat.set(1, 1);

    // Roughness map — same streak pattern as grayscale so the highlights
    // catch unevenly. Slightly rougher overall than the base mat.
    const rc = document.createElement('canvas');
    rc.width = W; rc.height = H;
    const rctx = rc.getContext('2d');
    const rimg = rctx.createImageData(W, H);
    for (let x = 0; x < W; x++) {
      const v = (Math.sin(x * 78.233) * 43758.5453) % 1;
      const base = Math.round(80 + Math.abs(v) * 80);
      for (let y = 0; y < H; y++) {
        const grain = ((Math.sin(x * 0.9 + y * 4.3) * 6) | 0);
        const g = Math.max(0, Math.min(255, base + grain));
        const i = (y * W + x) * 4;
        rimg.data[i] = g; rimg.data[i + 1] = g; rimg.data[i + 2] = g; rimg.data[i + 3] = 255;
      }
    }
    rctx.putImageData(rimg, 0, 0);
    const roughness = new THREE.CanvasTexture(rc);
    roughness.wrapS = THREE.RepeatWrapping;
    roughness.wrapT = THREE.RepeatWrapping;
    roughness.repeat.set(1, 1);

    return { normal, roughness };
  }

  const goldMaterial = new THREE.MeshStandardMaterial({ color: 0xe5b45c, metalness: 1.0, roughness: 0.15 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 1.0, roughness: 0.1 });
  const tealMaterial = new THREE.MeshStandardMaterial({ color: 0x006666, metalness: 0.4, roughness: 0.4 });
  const drumMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.7, roughness: 0.3 });
  // Procedural brushed-aluminum normal + roughness maps. Vertical streaks
  // give the look of milled metal scratches without a single extra vertex —
  // displacement on a 12-vert BoxGeometry would do nothing visible anyway.
  const aluminumMaps = buildBrushedAluminumMaps();
  const aluminumMat = new THREE.MeshStandardMaterial({
    color: 0xaaaaaa,
    metalness: 0.9,
    roughness: 0.55,
    normalMap: aluminumMaps.normal,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: aluminumMaps.roughness,
  });
  const whiteBracketMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, metalness: 0.2, roughness: 0.6 });

  const drumMesh = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.02, R + 0.02, HEIGHT_TOTAL - 1, 64), drumMaterial);
  drumMesh.receiveShadow = true;
  jukeboxGroup.add(drumMesh);
  const rimGeo = new THREE.TorusGeometry(R + 0.2, 0.6, 16, 64);
  const topRim = new THREE.Mesh(rimGeo, goldMaterial);
  topRim.rotation.x = Math.PI / 2; topRim.position.y = HEIGHT_TOTAL / 2;
  topRim.castShadow = true;
  jukeboxGroup.add(topRim);
  const botRim = new THREE.Mesh(rimGeo, goldMaterial);
  botRim.rotation.x = Math.PI / 2; botRim.position.y = -HEIGHT_TOTAL / 2;
  botRim.castShadow = true;
  jukeboxGroup.add(botRim);
  const neonGeo = new THREE.TorusGeometry(R + 1.2, 0.15, 16, 64);
  const neonTop = new THREE.Mesh(neonGeo, new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 2.0 }));
  neonTop.rotation.x = Math.PI / 2; neonTop.position.y = HEIGHT_TOTAL / 2 + 0.5; jukeboxGroup.add(neonTop);
  const neonBot = new THREE.Mesh(neonGeo, new THREE.MeshStandardMaterial({ color: 0xff00ff, emissive: 0xff00ff, emissiveIntensity: 2.0 }));
  neonBot.rotation.x = Math.PI / 2; neonBot.position.y = -HEIGHT_TOTAL / 2 - 0.5; jukeboxGroup.add(neonBot);
  jukeboxGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(R + 1.6, R + 1.6, HEIGHT_TOTAL + 2, 64, 1, true), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.9, clearcoat: 1.0, side: THREE.FrontSide })));

  // ----- Brackets (baked into 3 merged geometries instead of ~80 meshes) -----
  // Each bracket was a Group of 1 base + 1–2 chrome accents, positioned in a
  // ring. None of them move relative to each other, so we bake the per-column
  // transform into the geometry once and merge by material. 36 cols × ~2.5
  // sub-meshes = ~90 draw calls → 3 draw calls (one per material).
  const tealGeos = [];
  const aluminumGeos = [];
  const chromeGeos = [];
  const Y_UP = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < COLS; i++) {
    const theta = i * COL_ANGLE;
    const groupMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.sin(theta) * (R + 0.12), 0, Math.cos(theta) * (R + 0.12)),
      new THREE.Quaternion().setFromAxisAngle(Y_UP, theta),
      new THREE.Vector3(1, 1, 1),
    );
    if (i % 2 === 0) {
      // Teal base centered in the bracket
      const b = new THREE.BoxGeometry(0.5, HEIGHT_TOTAL - 2, 0.4);
      b.applyMatrix4(groupMatrix);
      tealGeos.push(b);
      // Two chrome pipes flanking the front face
      for (const dx of [-0.15, 0.15]) {
        const p = new THREE.BoxGeometry(0.04, HEIGHT_TOTAL - 2, 0.04);
        p.applyMatrix4(new THREE.Matrix4().multiplyMatrices(groupMatrix, new THREE.Matrix4().setPosition(dx, 0, 0.2)));
        chromeGeos.push(p);
      }
    } else {
      // Aluminum base + single chrome spine
      const b = new THREE.BoxGeometry(0.3, HEIGHT_TOTAL - 2, 0.15);
      b.applyMatrix4(groupMatrix);
      aluminumGeos.push(b);
      const s = new THREE.BoxGeometry(0.1, HEIGHT_TOTAL - 2, 0.08);
      s.applyMatrix4(new THREE.Matrix4().multiplyMatrices(groupMatrix, new THREE.Matrix4().setPosition(0, 0, 0.1)));
      chromeGeos.push(s);
    }
  }
  const tealMerged = mergeGeometries(tealGeos, false);
  const aluminumMerged = mergeGeometries(aluminumGeos, false);
  const chromeBracketsMerged = mergeGeometries(chromeGeos, false);
  // mergeGeometries copies vertex data, so the source geometries are dead weight now.
  for (const g of [...tealGeos, ...aluminumGeos, ...chromeGeos]) g.dispose();
  for (const merged of [tealMerged, aluminumMerged, chromeBracketsMerged]) {
    if (!merged) continue;
    const mat = merged === tealMerged ? tealMaterial
              : merged === aluminumMerged ? aluminumMat
              : chromeMat;
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true; m.receiveShadow = true;
    jukeboxGroup.add(m);
  }

  // ----- Row divider torii (ROWS+1 of them, all on whiteBracketMat) → 1 mesh
  const ringGeos = [];
  for (let r = 0; r <= ROWS; r++) {
    const y = startY - r * ROW_SPACING + ROW_SPACING / 2;
    // 8×32 segments instead of 16×64 — these are tiny rings seen edge-on most
    // of the time, the smoothness drop is invisible. 4× fewer triangles each.
    const g = new THREE.TorusGeometry(R + 0.08, 0.1, 8, 32);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(0, y, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
      new THREE.Vector3(1, 1, 1),
    ));
    ringGeos.push(g);
  }
  const ringsMerged = mergeGeometries(ringGeos, false);
  for (const g of ringGeos) g.dispose();
  if (ringsMerged) {
    const ringsMesh = new THREE.Mesh(ringsMerged, whiteBracketMat);
    ringsMesh.castShadow = true; ringsMesh.receiveShadow = true;
    jukeboxGroup.add(ringsMesh);
  }

  const ledGeo = new THREE.CylinderGeometry(0.02, 0.02, CARD_W - 0.1, 8);
  ledGeo.rotateZ(Math.PI / 2);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const localLed1 = new THREE.PointLight(0xffd580, 0, 15);
  localLed1.add(new THREE.Mesh(ledGeo, ledMat));
  jukeboxGroup.add(localLed1);
  const localLed2 = new THREE.PointLight(0xffd580, 0, 15);
  localLed2.add(new THREE.Mesh(ledGeo, ledMat));
  jukeboxGroup.add(localLed2);

  // Convergence-tracker LEDs that orbit just under the top rim. They start
  // from the diametrically-opposite side of the active card and travel in
  // opposite directions to meet at the card — guiding the eye home no matter
  // which way you've spun the drum.
  //
  // Each tracker is TWO things:
  //  1. The visible LED bead (HDR-bright MeshBasic sphere) — the "lit emitter"
  //     you actually see, made into a bloomed dot by UnrealBloomPass.
  //  2. A PointLight at the same position — adds a soft radial wash on
  //     whatever card is directly below. PointLight (not SpotLight) because
  //     a SpotLight's cone, however feathered, intersects flat card surfaces
  //     as a recognizable cone outline — that's what reads as "theater spot",
  //     not LED. PointLights produce smooth distance-based falloff with no
  //     visible beam geometry, exactly like a real LED downlight.
  //
  // The top rim torus is at y = HEIGHT_TOTAL/2 with tube radius 0.6, so its
  // underside sits at y = HEIGHT_TOTAL/2 - 0.6. We park them just below that.
  const TRACKER_R = R + 0.2;
  // Top rim's underside (lowest point of the torus tube) sits at
  // HEIGHT_TOTAL/2 - 0.6. With a bead radius of 0.07, parking the bead center
  // 0.67 below the rim center puts the TOP of the bead flush against the
  // rim — looks like the LED is mounted to the underside of the chrome.
  const TRACKER_Y = HEIGHT_TOTAL / 2 - 0.67;
  const TRACKER_PAIRS = 2; // → 4 lights total (2 CW + 2 CCW)
  // The bead is the LED itself — a tiny bright sphere. The halo is a
  // camera-facing sprite with a radial-gradient texture, additively blended
  // over whatever's behind. Together: a bright dot with a soft glow ring.
  // Same look as a bloom pass on the LED specifically, but at ~1% of the cost
  // (one quad per LED, no fullscreen blur). Works on every mobile GPU.
  const ledBeadGeo = new THREE.SphereGeometry(0.07, 12, 8);
  const ledBeadMat = new THREE.MeshBasicMaterial({ color: 0xffeebb });
  // Procedural soft-radial-gradient texture for the halo. Shared by all 4
  // sprites so it lives in VRAM exactly once.
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = 128; haloCanvas.height = 128;
  const hctx = haloCanvas.getContext('2d');
  const haloGrad = hctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  haloGrad.addColorStop(0.0, 'rgba(255, 220, 150, 1.00)');
  haloGrad.addColorStop(0.25, 'rgba(255, 200, 120, 0.55)');
  haloGrad.addColorStop(0.55, 'rgba(255, 180, 100, 0.15)');
  haloGrad.addColorStop(1.0, 'rgba(255, 160, 80,  0.00)');
  hctx.fillStyle = haloGrad;
  hctx.fillRect(0, 0, 128, 128);
  const haloTex = new THREE.CanvasTexture(haloCanvas);
  haloTex.needsUpdate = true;
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const trackers = [];
  for (let i = 0; i < TRACKER_PAIRS; i++) {
    const offset = i / TRACKER_PAIRS; // stagger across the cycle
    for (const dir of [1, -1]) {
      // PointLight(color, intensity, distance, decay)
      //  • distance 4   — short throw; only the cards directly below are lit
      //  • decay 2      — natural inverse-square falloff (smooth gradient, no
      //                   visible cone shape — that's the LED-vs-spot tell)
      const light = new THREE.PointLight(0xffd580, 0, 4, 2);
      light.visible = false;
      jukeboxGroup.add(light);
      // Visible LED bead — the dot you actually see as the "LED" itself.
      const bead = new THREE.Mesh(ledBeadGeo, ledBeadMat);
      bead.visible = false;
      jukeboxGroup.add(bead);
      // Halo sprite — billboarded glow disc behind the bead. Size in world
      // units; ~0.7 looks roughly like the bloom radius we had before.
      const halo = new THREE.Sprite(haloMat);
      halo.scale.set(0.7, 0.7, 1);
      halo.visible = false;
      jukeboxGroup.add(halo);
      trackers.push({ light, bead, halo, dir, offset });
    }
  }

  // Queue indicator — pure shader-driven. Each card's atlas geometry has a
  // per-instance `aHighlight` (0..1) attribute; the fragment shader adds an
  // HDR-cyan emissive wash to the top portion of the card when that value is
  // non-zero (see makeAtlasMat). Setting it to 1 lights the card up; lerping
  // back to 0 fades it out. **Zero real lights** for the queue indication —
  // the only added per-frame cost is one smoothstep + mul-add per FRAGMENT
  // ON CARDS ONLY, not the multiplicative per-light cost a real PointLight
  // would impose on every Standard material in the scene.

  const queueByUri = new Map();
  // Before: COLS*ROWS draw calls, one Mesh + Material + CanvasTexture per card.
  // After:  ceil(N / CELLS_PER_ATLAS) draw calls — one InstancedMesh per atlas.
  //         For a 320-card deck that's 1 draw call vs 320. Each card still
  //         renders from a 256×100 region with the same anisotropy and minFilter
  //         as before, so pixel-for-pixel output is identical.
  //
  // Layout: each atlas packs up to 16 × 40 = 640 cells in a 4096² canvas.
  // A slot (c, r) maps deterministically to a fixed (atlasIdx, cellIdx) so
  // "recycling" a card via placeIncoming just redraws its existing cell in the
  // existing atlas — no instance reassignment needed.
  const ATLAS_SIZE = 4096;
  const CELL_W = 256;
  const CELL_H = 100;
  const COLS_PER_ATLAS = Math.floor(ATLAS_SIZE / CELL_W); // 16
  const ROWS_PER_ATLAS = Math.floor(ATLAS_SIZE / CELL_H); // 40
  const CELLS_PER_ATLAS = COLS_PER_ATLAS * ROWS_PER_ATLAS; // 640
  const totalSlots = COLS * ROWS;
  const atlasCount = Math.max(1, Math.ceil(totalSlots / CELLS_PER_ATLAS));

  // Looks like a Three.js Mesh's `.userData` sub-object to every consumer
  // (selectCard, ledMoveTo, the animate-loop lighting block) so we don't have
  // to rewrite every `card.userData.X` access — just swap the backing object.

  const cards = [];
  // O(1) URI → card lookup; kept in sync with `cards` in buildCard / placeIncoming.
  const cardByUri = new Map();
  let activeCard = null;
  const atlases = [];
  // Raycast targets — each entry is the InstancedMesh for one atlas.
  const cardInstancedMeshes = [];

  // Per-instance UV rect (offsetX, offsetY, scaleX, scaleY). Determined entirely
  // by the cell's grid position in the atlas. Inset by 0.5 px on every side so
  // linear filtering at the cell edge never reaches outside this cell (would
  // otherwise show a thin colored bleed at every card border).
  function makeAtlasGeo(capacity) {
    const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    const aUvRect = new Float32Array(capacity * 4);
    const inset = 0.5 / ATLAS_SIZE;
    for (let i = 0; i < capacity; i++) {
      const col = i % COLS_PER_ATLAS;
      const row = Math.floor(i / COLS_PER_ATLAS);
      // WebGL UV origin is bottom-left; canvas is top-down. Row 0 sits at
      // canvas y∈[0, CELL_H], which is UV-y∈[1 - CELL_H/ATLAS_SIZE, 1].
      aUvRect[i * 4 + 0] = (col * CELL_W) / ATLAS_SIZE + inset;
      aUvRect[i * 4 + 1] = 1 - ((row + 1) * CELL_H) / ATLAS_SIZE + inset;
      aUvRect[i * 4 + 2] = (CELL_W - 1) / ATLAS_SIZE;
      aUvRect[i * 4 + 3] = (CELL_H - 1) / ATLAS_SIZE;
    }
    geo.setAttribute('aUvRect', new THREE.InstancedBufferAttribute(aUvRect, 4));
    // Per-instance highlight intensity (0..1). Drives the cyan queue glow at
    // the top edge of the card via the shader patch in makeAtlasMat. The
    // animate loop lerps this toward a per-cell target each frame and
    // re-uploads the buffer when anything changed. Starts at 0 (no glow).
    const aHighlight = new Float32Array(capacity);
    const aHighlightAttr = new THREE.InstancedBufferAttribute(aHighlight, 1);
    aHighlightAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHighlight', aHighlightAttr);
    return geo;
  }

  function makeAtlasMat(texture) {
    // Same MeshStandardMaterial params as the original per-card material —
    // identical shading.
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      // VS — forward the per-instance UV rect + highlight to the fragment.
      // `vLocalUv` is the un-remapped 0..1 UV (used to mask the queue glow to
      // the top edge of the card surface), separate from the atlas-remapped
      // `vMapUv` that the standard map sampler uses.
      shader.vertexShader = `
attribute vec4 aUvRect;
attribute float aHighlight;
varying float vHighlight;
varying vec2 vLocalUv;
${shader.vertexShader}
`.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = uv * aUvRect.zw + aUvRect.xy;
        #endif
        vHighlight = aHighlight;
        vLocalUv = uv;
        `,
      );
      // FS — adds an HDR-cyan emissive wash to the top portion of the card
      // when aHighlight > 0. Replaces the 40 PointLights the queue indicator
      // previously used (each of which forced every Standard material in the
      // scene to evaluate one more light per fragment). Now: 1 smoothstep +
      // 1 mul-add per fragment ON CARDS ONLY, zero scene-light cost, zero
      // material recompile churn when queueing.
      // One simulated point light at the top-center edge of the card. Single
      // light reads more clearly than a top+bottom pair because the eye
      // expects a card to be "lit from above" — having two equally bright
      // spots makes the surface ambiguous. The light is pushed slightly
      // *outside* the card edge (y=1.08) so its brightest pixel lands
      // inside the card, not on the seam.
      //
      // Inverse-square falloff (the same model a real PBR PointLight uses):
      // `LH / (LH + dist²)`. The "light-height" term LH sets how concentrated
      // the hotspot is — small LH → tight punchy dot, large LH → soft glow
      // extending into the card.
      //
      // Aspect correction: cards are 2.56× wider than tall, so we scale
      // x-distance by 2.56 in card-local space — keeps the hotspot circular
      // in pixel space instead of stretching it into a horizontal ellipse.
      const ASPECT = (CARD_W / CARD_H).toFixed(3);
      shader.fragmentShader = `
varying float vHighlight;
varying vec2 vLocalUv;
${shader.fragmentShader}
`.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vHighlight > 0.0) {
          vec2 aspect = vec2(${ASPECT}, 1.0);
          vec2 d = (vLocalUv - vec2(0.5, 1.08)) * aspect;
          const float LH = 0.015;
          // Squared falloff — sharper drop-off than raw inverse-square. Keeps
          // the glow contained to the top portion of the card instead of
          // blowing out the whole upper half.
          float glow = LH / (LH + dot(d, d));
          glow *= glow;
          // Pure cyan, peak (0, 3.5, 5.0) — bright enough to crush to white
          // at the very center under NeutralToneMapping, with cyan visible
          // only in a small halo around the hotspot. R=0 keeps the blowout
          // blue-white, not desaturated grey.
          totalEmissiveRadiance += vec3(0.0, 3.5, 5.0) * vHighlight * glow;
        }
        `,
      );
    };
    return mat;
  }

  {
    // Build atlases up front. Empty cells get a zero-scale matrix so they
    // don't render; buildCard fills in real matrices as cards arrive.
    const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let a = 0; a < atlasCount; a++) {
      const startSlot = a * CELLS_PER_ATLAS;
      const capacity = Math.min(CELLS_PER_ATLAS, totalSlots - startSlot);
      const canvas = document.createElement('canvas');
      canvas.width = ATLAS_SIZE;
      canvas.height = ATLAS_SIZE;
      const ctx = canvas.getContext('2d');
      const texture = new THREE.CanvasTexture(canvas);
      // Same filtering as the old per-card CanvasTexture — quality unchanged.
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.minFilter = THREE.LinearFilter;
      const geo = makeAtlasGeo(capacity);
      const mat = makeAtlasMat(texture);
      const mesh = new THREE.InstancedMesh(geo, mat, capacity);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Default bounding sphere is one card. Skip frustum culling so the
      // InstancedMesh isn't dropped when the camera is close to the drum.
      mesh.frustumCulled = false;
      for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, hiddenMatrix);
      mesh.instanceMatrix.needsUpdate = true;
      jukeboxGroup.add(mesh);
      cardInstancedMeshes.push(mesh);
      // The aHighlight InstancedBufferAttribute is on the geometry; reach in
      // and grab it so the per-frame fade loop can flag re-uploads.
      const highlightAttr = geo.getAttribute('aHighlight');
      atlases.push({
        canvas, ctx, texture, mesh, capacity,
        cellRefs: Array(capacity).fill(null),
        highlightCurrent: highlightAttr.array,
        highlightTarget: new Float32Array(capacity),
        highlightAttr,
        highlightDirty: false,
      });
    }
  }

  function slotToAtlas(c, r) {
    const idx = c * ROWS + r;
    return { atlasIdx: Math.floor(idx / CELLS_PER_ATLAS), cellIdx: idx % CELLS_PER_ATLAS };
  }

  function stampCell(atlasIdx, cellIdx, art) {
    const atlas = atlases[atlasIdx];
    const col = cellIdx % COLS_PER_ATLAS;
    const row = Math.floor(cellIdx / COLS_PER_ATLAS);
    atlas.ctx.clearRect(col * CELL_W, row * CELL_H, CELL_W, CELL_H);
    atlas.ctx.drawImage(art, col * CELL_W, row * CELL_H);
    // needsUpdate is just a flag — Three batches subsequent stamps into a
    // single texSubImage2D before the next render. Stamping 320 cards on init
    // triggers one upload, not 320.
    atlas.texture.needsUpdate = true;
  }

  // Reused across buildCard calls — Object3D allocations aren't free.
  const cardDummy = new THREE.Object3D();

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const categories = ['extended play', 'varieties', 'your picks', 'favorites', 'soul', 'popular', 'hit tunes', 'jazz', 'country', 'rock & roll'];

  // All category labels live under this group so the 'C' key toggle can flip
  // them with a single .visible assignment.
  const categoryGroup = new THREE.Group();
  categoryGroup.visible = mode.showCategories;
  jukeboxGroup.add(categoryGroup);

  // Track empty slots (for the queue) and slots already taken by queued cards
  const emptySlots = [];
  const queueCards = [];

  function trackToCardSong(t, c, r) {
    const code = letters[c % letters.length] + (r + 1);
    if (t.titleA && t.titleB) {
      return { ...t, titleA: t.titleA, titleB: t.titleB, code };
    }
    const words = (t.name || '').split(/\s+/).filter(Boolean);
    const half = Math.ceil(words.length / 2);
    const titleA = words.length > 1 ? words.slice(0, half).join(' ') : (t.name || '');
    const titleB = words.length > 1 ? words.slice(half).join(' ') : (t.album || t.name || '');
    return { ...t, titleA, titleB, code };
  }

  function stampSlot(c, r, art) {
    const theta = -Math.PI + c * COL_ANGLE + COL_ANGLE / 2;
    const { atlasIdx, cellIdx } = slotToAtlas(c, r);
    stampCell(atlasIdx, cellIdx, art);
    const x = Math.sin(theta) * (R + 0.05);
    const z = Math.cos(theta) * (R + 0.05);
    const y = startY - r * ROW_SPACING;
    cardDummy.position.set(x, y, z);
    cardDummy.rotation.set(0, theta, 0);
    cardDummy.scale.set(1, 1, 1);
    cardDummy.updateMatrix();
    const atlas = atlases[atlasIdx];
    atlas.mesh.setMatrixAt(cellIdx, cardDummy.matrix);
    atlas.mesh.instanceMatrix.needsUpdate = true;
    return { atlasIdx, cellIdx, y, theta };
  }

  function buildCard(t, c, r) {
    const song = trackToCardSong(t, c, r);
    const { canvas: art, accent, bg, alt } = generateCardArt(song);
    const placed = stampSlot(c, r, art);
    const ref = {
      userData: {
        isCard: true, song, baseY: placed.y, theta: placed.theta, c, r,
        accentColor: accent, bgColor: bg, altColor: alt,
        accentCol: new THREE.Color(accent),
        bgCol: new THREE.Color(bg),
        altCol: new THREE.Color(alt || '#ffffff'),
      },
      atlasIdx: placed.atlasIdx,
      cellIdx: placed.cellIdx,
    };
    atlases[placed.atlasIdx].cellRefs[placed.cellIdx] = ref;
    return ref;
  }

  // Bottom-rim category labels as a single InstancedMesh + texture atlas.
  // Before: COLS canvases / textures / materials / draw calls — one per column,
  //         all rendering the same 10 unique strings.
  // After:  1 canvas (CAT_N rows stacked vertically), 1 texture, 1 material,
  //         1 draw call. Each instance picks its row via a per-instance UV-y
  //         offset. Pixels are identical — the canvas is drawn with the same
  //         font, size, and fill as before; only the packing changes.
  {
    const CAT_W = 256, CAT_H = 64, CAT_N = categories.length;
    const catCanvas = document.createElement('canvas');
    catCanvas.width = CAT_W; catCanvas.height = CAT_H * CAT_N;
    const cctx = catCanvas.getContext('2d');
    cctx.fillStyle = '#006666'; cctx.fillRect(0, 0, CAT_W, CAT_H * CAT_N);
    cctx.fillStyle = '#ffffff'; cctx.font = "bold 28px 'Oswald'";
    cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
    for (let i = 0; i < CAT_N; i++) {
      cctx.fillText(categories[i].toUpperCase(), CAT_W / 2, i * CAT_H + CAT_H / 2);
    }
    const catTex = new THREE.CanvasTexture(catCanvas);
    catTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    catTex.needsUpdate = true;

    // Per-instance UV-y offset. WebGL UV-y origin is bottom-left while the
    // canvas was drawn top-down, so instance c (showing row c % CAT_N) wants
    // its band starting at UV-y = 1 - (rowIdx + 1) / CAT_N.
    const catGeo = new THREE.PlaneGeometry(CARD_W * 0.9, 0.6);
    const aUvOffset = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) {
      aUvOffset[c] = 1 - ((c % CAT_N) + 1) / CAT_N;
    }
    catGeo.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(aUvOffset, 1));

    // Reactive to scene lighting (Standard material) AND self-illuminated via
    // emissiveMap so each label has its own dim warm glow.
    const CAT_SCALE_Y = (1 / CAT_N).toFixed(6);
    const catMat = new THREE.MeshStandardMaterial({
      map: catTex,
      emissiveMap: catTex,
      emissive: new THREE.Color(0xffd580),
      emissiveIntensity: 0.35,
      roughness: 0.7,
      metalness: 0.1,
    });
    catMat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float aUvOffset;\n' + shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv.y = vMapUv.y * ${CAT_SCALE_Y} + aUvOffset;
        #endif
        #ifdef USE_EMISSIVEMAP
          vEmissiveMapUv.y = vEmissiveMapUv.y * ${CAT_SCALE_Y} + aUvOffset;
        #endif
        `
      );
    };

    const catInstanced = new THREE.InstancedMesh(catGeo, catMat, COLS);
    catInstanced.receiveShadow = true;
    catInstanced.castShadow = false;
    const catDummy = new THREE.Object3D();
    for (let c = 0; c < COLS; c++) {
      const theta = -Math.PI + c * COL_ANGLE + COL_ANGLE / 2;
      catDummy.position.set(Math.sin(theta) * (R + 0.1), -startY - ROW_SPACING, Math.cos(theta) * (R + 0.1));
      catDummy.rotation.set(0, theta, 0);
      catDummy.updateMatrix();
      catInstanced.setMatrixAt(c, catDummy.matrix);
    }
    catInstanced.instanceMatrix.needsUpdate = true;
    categoryGroup.add(catInstanced);
  }

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const idx = c * ROWS + r;
      if (idx >= displayTracks.length) break;
      const t = displayTracks[idx];
      if (!t) { emptySlots.push({ c, r }); continue; }
      const card = buildCard(t, c, r);
      cards.push(card);
      cardByUri.set(card.userData.song.uri, card);
    }
  }

  // Light the cyan queue glow on a card. Sets the per-cell shader target to 1;
  // the per-frame fader in animate lerps the current value toward it. Re-queue
  // of the same URI is a no-op apart from bumping the target back up — which
  // also revives a still-fading-out cell smoothly.
  function markQueued(card) {
    const uri = card.userData.song.uri;
    let ref = queueByUri.get(uri);
    if (!ref) {
      const { atlasIdx, cellIdx } = slotToAtlas(card.userData.c, card.userData.r);
      ref = { atlasIdx, cellIdx };
      queueByUri.set(uri, ref);
    }
    const atlas = atlases[ref.atlasIdx];
    atlas.highlightTarget[ref.cellIdx] = 1;
    atlas.highlightDirty = true;
  }

  // Drop the per-cell target to 0; the per-frame fader will smoothly dim the
  // shader glow. The URI mapping is removed immediately — if the user
  // re-queues mid-fade, markQueued recomputes the same (atlasIdx, cellIdx)
  // (slotToAtlas is deterministic per (c, r)) and bumps the target back up,
  // so the fade-out reverses cleanly.
  function unmarkQueued(uri) {
    const ref = queueByUri.get(uri);
    if (!ref) return;
    const atlas = atlases[ref.atlasIdx];
    atlas.highlightTarget[ref.cellIdx] = 0;
    atlas.highlightDirty = true;
    queueByUri.delete(uri);
  }

  // Surface Spotify's existing queue at boot — every card whose track came in
  // via /me/player/queue gets a cyan indicator. They clear automatically when
  // the track starts playing (see syncNowPlaying / selectCard).
  for (const card of cards) {
    if (card.userData.song.source === 'queue') markQueued(card);
  }

  // Add a new now-playing track. Uses an empty slot if available, otherwise
  // recycles the oldest previously-queued slot. Returns the (existing or new)
  // card for the given URI, or null if none can be placed.
  function placeIncoming(raw) {
    const existing = cardByUri.get(raw.uri);
    if (existing) return existing;
    let slot;
    if (emptySlots.length > 0) {
      slot = emptySlots.shift();
    } else {
      // Recycle the oldest queued card — but skip the one that's currently
      // playing. Rotate it to the back of the queue and try the next.
      while (queueCards.length > 0 && queueCards[0] === activeCard) {
        queueCards.push(queueCards.shift());
      }
      if (queueCards.length > 0) {
        const oldest = queueCards.shift();
        slot = { c: oldest.userData.c, r: oldest.userData.r };
        cards.splice(cards.indexOf(oldest), 1);
        cardByUri.delete(oldest.userData.song.uri);
        // The atlas cell gets overwritten by buildCard below — there's no
        // per-card material or texture to dispose anymore.
      }
    }
    if (!slot) return null;
    const card = buildCard(raw, slot.c, slot.r);
    cards.push(card);
    cardByUri.set(card.userData.song.uri, card);
    queueCards.push(card);
    // Force the throttled shadow to re-evaluate next frame so the new card
    // casts shadow without waiting for the camera to move.
    lastShadowAz = NaN;
    return card;
  }

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // Card the LEDs are currently parked at. When this differs from activeCard,
  // the animate loop fades them out, repositions them, then fades them back in
  // at the new card — no flicker from an instant jump.
  let ledCard = null;
  function ledMoveTo(card) {
    const data = card.userData;
    const yTop = data.baseY + CARD_H / 2 - 0.02;
    const yBot = data.baseY - CARD_H / 2 + 0.02;
    localLed1.position.set(Math.sin(data.theta) * (R + 0.14), yTop, Math.cos(data.theta) * (R + 0.14));
    localLed1.rotation.y = data.theta;
    localLed2.position.set(Math.sin(data.theta) * (R + 0.14), yBot, Math.cos(data.theta) * (R + 0.14));
    localLed2.rotation.y = data.theta;
  }

  // Bring the playing track to life. Finds (or places via the queue) the card
  // for the given Spotify item, sets it as active, and jumps the drum front-and-center.
  function syncNowPlaying(item, contextUri) {
    if (!item?.uri) return;
    let match = cardByUri.get(item.uri);
    if (!match) {
      match = placeIncoming({
        uri: item.uri,
        name: item.name,
        artist: (item.artists || []).map((a) => a.name).join(', '),
        album: item.album?.name ?? '',
        source: 'now',
        contextUri,
      });
    }
    if (!match || match === activeCard) return;
    activeCard = match;
    // Whatever's playing now isn't "queued" anymore — clear the indicator if
    // we had one on this track (poll-discovered or long-press-added).
    unmarkQueued(match.userData.song.uri);
    onActiveChange(true);
    mode.goToActiveCard?.();
  }

  async function selectCard(card) {
    if (activeCard === card) {
      activeCard = null;
      onActiveChange(false);
      return;
    }
    playSelectionSound();
    activeCard = card;
    // Picking a card to PLAY removes its queued indicator (if any) — the
    // user explicitly bumped it to "now playing".
    unmarkQueued(card.userData.song.uri);
    onActiveChange(true);
    // If we're sitting at fit-zoom and the user just picked a card to play,
    // snap in on it. Already-zoomed-in stays put — the user clearly tapped
    // the one they wanted and doesn't need a camera move.
    if (mode.zoom < ZOOM_AUTO_THRESHOLD) {
      mode.zoom = 1;
      mode.goToActiveCard?.();
    }
    // Skip the API call for fake debug URIs.
    if (!mode.debug) {
      // Pass the playlist context URI (set during loadAllTracks) so Spotify
      // keeps playing the rest of the playlist after this track instead of
      // stopping. Falls back to single-URI play if the track has no known
      // context (e.g. a `queue` source).
      const { uri, contextUri } = card.userData.song;
      try {
        await spotify().play(uri, contextUri);
        // First play of the session — push the user's preferred shuffle
        // state to Spotify. The shuffle endpoint 404s without an active
        // device, which is why we wait until after a successful play.
        if (!shuffleInitialized) {
          shuffleInitialized = true;
          void spotify().setShuffle(mode.shuffle).catch(() => {});
        }
      } catch (err) {
        // play() now auto-recovers from NO_ACTIVE_DEVICE by transferring to
        // any known device and retrying. If we still got here, either the
        // account has zero devices Spotify knows about, or something else
        // (bad URI, auth issue) went wrong. Surface it so the user knows
        // why nothing's playing.
        console.warn('[jukebox] play() failed:', err?.message ?? err);
        onPlaybackError(err?.message ?? 'Playback failed');
        // Roll the active-card highlight back since the track isn't really
        // playing — keeps the UI honest.
        activeCard = null;
        onActiveChange(false);
      }
    }
  }

  // Long-press handler. Three behaviors depending on the card's state:
  //  • Currently playing → no-op (can't queue what's already playing).
  //  • Already queued → un-queue the visual indicator (NOTE: Spotify's Web
  //    API has no remove-from-queue endpoint, so the track will still play
  //    through; this is a local-only "I changed my mind, hide the marker"
  //    affordance until Spotify exposes a real delete).
  //  • Otherwise → POST /me/player/queue + light up the cyan indicator.
  async function queueCard(card) {
    if (card === activeCard) return;
    const uri = card.userData.song.uri;
    if (queueByUri.has(uri)) {
      unmarkQueued(uri);
      return;
    }
    playSelectionSound();
    markQueued(card);
    if (mode.debug) return;
    try { await spotify().addToQueue(uri); } catch {}
  }

  // Tap/drag/pinch handling:
  //  • Tap on card (<TAP_MAX_MS, <DRAG_THRESHOLD px) → play it
  //  • Long-press on card (≥TAP_MAX_MS, <DRAG_THRESHOLD px) → add to queue
  //  • Single-finger vertical drag → mode.lighting
  //  • Single-finger horizontal drag → drum rotation (custom, see onPointerMove)
  //  • Two-finger pinch → mode.zoom (mobile equivalent of mouse wheel)
  //  • Double-tap on chrome → snap zoom max/min
  const DRAG_THRESHOLD = 6;
  const TAP_MAX_MS = 350;        // anything held longer becomes a long-press
  const DOUBLE_TAP_MS = 350;
  let downX = 0, downY = 0, lastX = 0, lastY = 0, isDragging = false;
  let lastTapAt = 0;
  // Long-press fires VIA TIMER at TAP_MAX_MS — we don't wait for pointerup.
  // `longPressTimer` is cleared on lift / drag / pinch. `longPressFired` keeps
  // pointerup from also treating the same gesture as a tap.
  let longPressTimer = null;
  let longPressFired = false;
  // Momentum state for the horizontal drag → drum rotation. azVelocity is the
  // rotational speed (rad/s) the camera should keep coasting at after release.
  // Sampled from the last pointermove (dx/dt), then decayed each frame in
  // animate via MOMENTUM_FRICTION until it falls below MOMENTUM_EPS.
  let azVelocity = 0;
  let lastMoveTime = 0;
  const MOMENTUM_FRICTION = 3.0; // nepers/sec — ~95% lost in 1s, smooth ice-rink coast
  const MOMENTUM_EPS = 0.001;    // rad/s — below this we just stop
  const activePointers = new Map();
  let pinchBaseDist = 0;
  let pinchBaseZoom = 0;
  let isPinching = false;
  function getXY(event) {
    return { x: event.clientX, y: event.clientY };
  }
  // Apply a delta azimuth (rad) to the camera by rotating its (x, z) around
  // origin. Preserves both radius and y (polar). Used by drag, momentum, and
  // auto-orbit so they all share one code path.
  function applyAzimuthDelta(delta) {
    const az = Math.atan2(camera.position.x, camera.position.z) + delta;
    const r = Math.hypot(camera.position.x, camera.position.z);
    camera.position.x = Math.sin(az) * r;
    camera.position.z = Math.cos(az) * r;
  }
  // Raycast helper — translates a screen-space (x, y) into a CardRef or null.
  // Shared by the long-press timer and the pointerup tap handler.
  function cardAtScreenPoint(x, y) {
    mouse.x = (x / window.innerWidth) * 2 - 1;
    mouse.y = -(y / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(cardInstancedMeshes);
    if (!hits.length) return null;
    const hit = hits[0];
    const atlasIdx = cardInstancedMeshes.indexOf(hit.object);
    const cellIdx = hit.instanceId;
    return atlasIdx >= 0 && cellIdx != null ? atlases[atlasIdx].cellRefs[cellIdx] : null;
  }
  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }
  function onPointerDown(event) {
    initAudio();
    // Pull focus back to our container so the canvas / iOS selection halo
    // doesn't steal keyboard input from us.
    container.focus({ preventScroll: true });
    const { x, y } = getXY(event);
    if (event.pointerId !== undefined) activePointers.set(event.pointerId, { x, y });
    downX = x; downY = y; lastX = x; lastY = y;
    isDragging = true;
    // Touching the screen always cancels any in-flight momentum coast — the
    // user clearly wants to grab the drum, not chase it.
    azVelocity = 0;
    lastMoveTime = performance.now();
    longPressFired = false;
    cancelLongPress();
    // Arm the long-press timer. If it fires (TAP_MAX_MS) without movement /
    // lift / second finger, we queue the card under the original down point.
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      // Bail if a second finger arrived (pinch) or the user drifted.
      if (isPinching) return;
      if (Math.hypot(lastX - downX, lastY - downY) > DRAG_THRESHOLD) return;
      const ref = cardAtScreenPoint(downX, downY);
      if (!ref) return;
      longPressFired = true;
      try { navigator.vibrate?.(15); } catch {}
      void queueCard(ref);
    }, TAP_MAX_MS);
    if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      pinchBaseDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchBaseZoom = mode.zoom;
      isPinching = true;
      controls.enabled = false; // freeze drum rotation while pinching
      cancelLongPress();
    }
  }
  function onPointerMove(event) {
    if (!isDragging) return;
    const { x, y } = getXY(event);
    if (event.pointerId !== undefined) activePointers.set(event.pointerId, { x, y });

    if (isPinching && activePointers.size >= 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const ratio = dist / Math.max(pinchBaseDist, 1);
      // Spread → zoom in; pinch → zoom out. Scale 1× of dist change ≈ full range.
      mode.zoom = clamp(pinchBaseZoom + (ratio - 1), 0, 1);
      lastX = x; lastY = y; // keep lasts current so post-pinch deltas don't jump
      return;
    }

    const now = performance.now();
    // Clamp dt — sub-millisecond samples blow up the velocity divisor, and a
    // multi-second gap means the user paused. Either way, treat the sample
    // as a "single-frame" move at ~60Hz so the velocity stays sane.
    const dt = Math.min(0.1, Math.max(0.001, (now - lastMoveTime) / 1000));
    lastMoveTime = now;

    const dx = x - lastX;
    const dy = y - lastY;
    lastX = x;
    lastY = y;

    // If the user drifts off the down-point past the drag threshold, the
    // gesture is a drag (rotation / lighting), not a long-press — cancel the
    // pending timer so we don't queue under their finger mid-scroll.
    if (longPressTimer && Math.hypot(x - downX, y - downY) > DRAG_THRESHOLD) {
      cancelLongPress();
    }

    // Vertical → lighting blend (unchanged).
    mode.lighting = clamp(mode.lighting - dy * 0.003, 0, 1);

    // Horizontal → direct drum rotation. Same 1:1 derivation as the old
    // OrbitControls rotateSpeed math: the frontmost card travels Δθ·R world
    // units, which projects on screen to Δθ·R·viewportH/2 / ((Dcam−R)·tan(vFov/2)).
    // Solving for Δθ such that the projected card motion equals dx pixels:
    //   Δθ = (dx / viewportH) · 2·(Dcam − R)·tan(vFov/2) / R
    // Sign: drag right → camera rotates left in world → drum appears to follow finger.
    if (dx !== 0) {
      const dragDist = Math.max(0.1, camera.position.length() - R);
      const halfVFov = (camera.fov * Math.PI) / 360;
      const deltaAz = -(dx / window.innerHeight) * (2 * dragDist * Math.tan(halfVFov)) / R;
      applyAzimuthDelta(deltaAz);
      // Sample velocity from THIS move event only — captures intent at the
      // moment the finger lifts, ignoring earlier slow exploration.
      azVelocity = deltaAz / dt;
    }
  }
  function onPointerUp(event) {
    if (event.pointerId !== undefined) activePointers.delete(event.pointerId);
    if (activePointers.size < 2 && isPinching) {
      isPinching = false;
      controls.enabled = true;
    }
    if (activePointers.size > 0) return; // wait for all fingers to lift
    isDragging = false;
    // Whichever way this lift goes, the pending long-press is done.
    cancelLongPress();
    // If the long-press timer already fired and queued a card, the gesture is
    // resolved — don't double-treat the lift as a tap-to-play.
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    const { x, y } = getXY(event);
    const dx = x - downX, dy = y - downY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) return;
    // Only short presses reach here — anything ≥ TAP_MAX_MS was handled by
    // the timer above (or cancelled by drag).
    const ref = cardAtScreenPoint(x, y);
    if (ref) {
      selectCard(ref);
      lastTapAt = 0;
      return;
    }
    // Empty space (chrome / background) — double-tap toggles zoom extreme.
    const now = Date.now();
    if (now - lastTapAt < DOUBLE_TAP_MS) {
      mode.zoom = mode.zoom > 0.5 ? 0 : 1;
      lastTapAt = 0;
    } else {
      lastTapAt = now;
    }
  }
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // Scroll wheel drives zoom (0 = fit, 1 = tight on cards). Track-pad pinch
  // also produces wheel events with ctrlKey set.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function onWheel(e) {
    e.preventDefault();
    const step = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.0025;
    mode.zoom = clamp(mode.zoom + step, 0, 1);
  }
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  // Viewport sync. iPadOS in particular doesn't reliably fire `resize` when
  // the app is backgrounded and reopened — the canvas stays at whatever
  // dimensions Safari thought the page was during minimization (often half-
  // width). We re-measure on every visibility/pageshow/orientation event and
  // defer the actual setSize with rAF so the visualViewport has finished
  // animating before we read from it.
  function applySize() {
    // visualViewport is more accurate than innerWidth during iOS restore
    // animations (innerWidth can lie for a few frames).
    const vv = window.visualViewport;
    const w = Math.round(vv?.width ?? window.innerWidth);
    const h = Math.round(vv?.height ?? window.innerHeight);
    if (w <= 0 || h <= 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, true);
  }
  let resizeRaf = 0;
  function scheduleResize() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      applySize();
      // One more on the next frame — covers cases where the first rAF still
      // saw an in-flight transition (iPad split-view, Stage Manager).
      requestAnimationFrame(applySize);
    });
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') scheduleResize();
  }
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  window.addEventListener('pageshow', scheduleResize);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.visualViewport?.addEventListener('resize', scheduleResize);

  // Poll now-playing. syncNowPlaying handles deck lookup, queue placement,
  // LED positioning, and the jump-to-card camera move. Skipped in debug mode
  // (the URIs are fake, the Spotify API would 4xx).
  const pollInterval = mode.debug
    ? null
    : setInterval(async () => {
        try {
          const d = await spotify().nowPlaying();
          if (d?.item) syncNowPlaying(d.item, d.context?.uri);
        } catch {}
      }, 8000);

  // Smooth jukebox-drum rotation to bring the active card front-and-center.
  // We rotate the group (not the camera) — OrbitControls' damping fights direct
  // camera position writes and produces no visible movement.
  let groupRotTarget = null;
  mode.goToActiveCard = () => {
    if (!activeCard) return;
    const curAz = controls.getAzimuthalAngle();
    // Card's world angle = card.theta + jukeboxGroup.rotation.y.
    // We want world angle == curAz so card faces the camera.
    groupRotTarget = curAz - activeCard.userData.theta;
    mode.isAutoTransitioning = false;
  };
  controls.addEventListener('start', () => { groupRotTarget = null; });

  // Below this zoom level the deck reads as "zoomed out" — small enough that
  // the user is in browse mode and benefits from a snap-in when they pick
  // something to play or land on a track that's already playing.
  const ZOOM_AUTO_THRESHOLD = 0.5;
  // Startup: if we arrived with a current track AND the deck is sitting at
  // fit-zoom, snap to it. Otherwise leave the camera wherever the user left
  // it (e.g. they zoomed out manually before the scene rebuilt).
  // (Previously: a 4-second setTimeout always forced zoom=1, even when the
  // user had deliberately backed out to see the whole drum.)
  let isSceneReady = false;
  function onSceneReady() {
    if (nowItem) {
      activeCard = null;
      syncNowPlaying(nowItem);
    }
    if (activeCard && mode.zoom < ZOOM_AUTO_THRESHOLD) {
      mode.zoom = 1;
      mode.goToActiveCard?.();
    }
  }

  const clock = new THREE.Clock();
  let raf = 0;
  // Shadow-update throttling. We trigger a shadow rebuild only when the
  // azimuth (which moves dirLight) or the drum's rotation (which moves the
  // shadow casters) has actually changed since the last shadow render.
  let lastShadowAz = NaN;
  let lastShadowGroupRot = NaN;
  const SHADOW_MOVEMENT_EPS = 0.0005; // ~0.03°

  // Scratch objects reused across frames to avoid 20+ allocations/frame.
  const _camOffset = new THREE.Vector3();
  const _camRight = new THREE.Vector3();
  const _camLerpTarget = new THREE.Vector3();
  const _origin = new THREE.Vector3(0, 0, 0);
  const _tColor1 = new THREE.Color();
  const _tColor2 = new THREE.Color();
  const _dColor1 = new THREE.Color(0xffeedd);
  const _dColor2 = new THREE.Color(0xaaeeff);
  const _rColor1 = new THREE.Color();
  const _rColor2 = new THREE.Color();
  const _scratchA = new THREE.Color();
  const _scratchB = new THREE.Color();
  const _scratchC = new THREE.Color();
  const _ambientWarm = new THREE.Color(0xffb060);
  const _camLightWarm = new THREE.Color(0xffb878);
  const _ledBase = new THREE.Color(0xffd580);
  const _ledTgt = new THREE.Color();

  function animate() {
    raf = requestAnimationFrame(animate);
    if (!isSceneReady) {
      isSceneReady = true;
      onSceneReady();
    }

    // Polar angle vs zoom: zoomed out → slight top-down tilt (spin7 fit mode);
    // zoomed in → lock to horizontal scroll only.
    const targetMinPolar = Math.PI / 2 + (Math.PI / 6 - Math.PI / 2) * (1 - mode.zoom);
    const targetMaxPolar = Math.PI / 2 + 0.1 * (1 - mode.zoom);
    controls.minPolarAngle += (targetMinPolar - controls.minPolarAngle) * 0.1;
    controls.maxPolarAngle += (targetMaxPolar - controls.maxPolarAngle) * 0.1;
    if (controls.minPolarAngle > controls.maxPolarAngle) controls.minPolarAngle = controls.maxPolarAngle;

    // Spin the drum to bring the active card front-and-center
    if (groupRotTarget !== null) {
      let delta = groupRotTarget - jukeboxGroup.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) < 0.002) {
        jukeboxGroup.rotation.y = groupRotTarget;
        groupRotTarget = null;
      } else {
        jukeboxGroup.rotation.y += delta * 0.1;
      }
    }

    // Auto-orbit (driven by ←/→ arrow keys, default 0 = off). Rotating the
    // camera around the jukebox — instead of spinning the jukeboxGroup — lets
    // the direction-tracking lights (dirLight, fillFrontAmber) follow along.
    // Time-based delta keeps the speed identical on 60 Hz and 120 Hz displays.
    // Single dt for the frame — shared by auto-orbit AND the drag-momentum
    // coast below. clock.getDelta() can only be called once per frame (a
    // second call returns 0), so we capture it once here.
    const dt = clock.getDelta();

    if (mode.spin) {
      // mode.spin is interpreted as CARDS PER SECOND so the perceived scroll
      // rate stays constant across drum sizes (a "1 card/s" setting moves
      // exactly one card past the camera per second regardless of COLS).
      const radPerSec = (mode.spin * 2 * Math.PI) / COLS;
      applyAzimuthDelta(radPerSec * dt);
    }

    // Drag-release momentum. After the user flings the drum, azVelocity is
    // the last sampled finger speed (rad/s). We integrate it into the camera
    // each frame and decay exponentially — `friction` controls how quickly
    // the drum slows to a stop. Dragging again zeros azVelocity (see
    // onPointerDown) so a touch always stops the coast immediately.
    if (!isDragging && azVelocity !== 0) {
      applyAzimuthDelta(azVelocity * dt);
      azVelocity *= Math.exp(-MOMENTUM_FRICTION * dt);
      if (Math.abs(azVelocity) < MOMENTUM_EPS) azVelocity = 0;
    }

    controls.update();
    if (categoryGroup.visible !== mode.showCategories) categoryGroup.visible = mode.showCategories;

    // Single read of az now that controls.update() has finished syncing —
    // reused by the zoom block + the dirLight orbit below. getAzimuthalAngle
    // internally walks a quat→spherical conversion, so caching it dodges that
    // work twice per frame.
    const az = controls.getAzimuthalAngle();

    const dist = camera.position.length();
    scene.fog.near = dist + 30; scene.fog.far = dist + 250;

    // The 1:1 drag math used to live here as `controls.rotateSpeed = ...` —
    // now done inline in onPointerMove via applyAzimuthDelta(), so the value
    // is sampled at the exact moment of input rather than once-per-frame.

    // Continuous zoom: 0 = fit-to-screen (wide FOV, full jukebox in view),
    // 1 = zoom-to-cards (telephoto FOV, height-fit on the cards).
    // Camera FOV + position smoothly lerp toward targets derived from mode.zoom.
    {
      const z = mode.zoom;
      // FOV at max zoom is interpolated from the normal 12° telephoto down
      // toward 2° as zoomFlat→1, giving a flat, near-orthographic perspective.
      // Camera distance compensates via hDist below so card size stays similar.
      const tightFOV = TIGHT_FOV_NORMAL + (TIGHT_FOV_FLAT - TIGHT_FOV_NORMAL) * mode.zoomFlat;
      const targetFOV = 45 + (tightFOV - 45) * z;
      camera.fov += (targetFOV - camera.fov) * 0.12;
      camera.updateProjectionMatrix();
      const vFOV = (camera.fov * Math.PI) / 180;
      // Cache the tan once — hDist and wDist below both use it on the same FOV.
      const tanHalfVFov = Math.tan(vFOV / 2);
      const hDist = (HEIGHT_TOTAL + 1) / (2 * tanHalfVFov);
      const wDist = (R * 2 + 4) / (2 * tanHalfVFov * camera.aspect);
      const fitDist = Math.max(hDist, wDist);
      // At max zoom, pull in past the strict height-fit so cards punch larger
      // in frame (FOV compression alone doesn't change apparent card size).
      const tightDist = hDist * mode.zoomTight;
      const targetDist = fitDist + (tightDist - fitDist) * z;
      const tx = Math.sin(az) * (R + targetDist);
      const tz = Math.cos(az) * (R + targetDist);
      _camLerpTarget.set(tx, 0, tz);
      camera.position.lerp(_camLerpTarget, 0.12);
      controls.target.lerp(_origin, 0.12);
    }

    // Offset the camera headlight to the right of the camera (relative to its
    // view direction), then aim it at the focal point. This grazes the cards
    // from the side instead of blowing out the center.
    _camOffset.subVectors(controls.target, camera.position);
    _camRight.crossVectors(_camOffset, camera.up).normalize();
    const offsetDist = _camOffset.length() * 0.6;
    cameraLight.position.copy(camera.position).addScaledVector(_camRight, offsetDist);
    cameraLight.target.position.copy(controls.target);

    const t = clock.getElapsedTime();

    // Continuous lighting blend: L=0 diner, L=1 rink. Compute both endpoints,
    // lerp by L. Fill lights ramp with the rink share.
    const z = mode.zoom;
    const L = mode.lighting;
    const ftt = (fit, tight) => fit + (tight - fit) * z;

    // Rink-mode fills, exaggerated. The saturated pink fill carries the rink
    // mood; we keep the desaturating whites/ambers small so the cyan/magenta
    // point lights actually punch through.
    fillWhite.intensity += ((L * 0.15) - fillWhite.intensity) * 0.05;
    fillAmber.intensity += ((L * 0.15) - fillAmber.intensity) * 0.05;
    fillPink.intensity += ((L * 1.4) - fillPink.intensity) * 0.05;
    fillFrontAmber.intensity += ((L * 0.30) - fillFrontAmber.intensity) * 0.05;

    // Point + neon emissive intensity is now L-dependent so the rink palette
    // actually CRESCENDOS as you drag toward rink, instead of being a constant
    // background drone. At L=0 the cyan/magenta are barely there (warm-tinted
    // by _tColor lerp anyway); at L=1 they're dramatic neon.
    const neonTarget = 0.5 + L * 5.0;          // 0.5 → 5.5 (was constant 2.5)
    const neonEmissive = 1.0 + L * 3.5;        // 1.0 → 4.5 (was constant 2.0)
    pointLight1.intensity += (neonTarget - pointLight1.intensity) * 0.05;
    pointLight2.intensity += (neonTarget - pointLight2.intensity) * 0.05;
    neonTop.material.emissiveIntensity = neonEmissive;
    neonBot.material.emissiveIntensity = neonEmissive;

    // Diner endpoint — bumped ~2x so pure-diner (L=0) reads as a vibrant warm
    // 50s diner instead of "regular indoor scene with bulbs".
    const dHemi = ftt(0.95, 0.0);
    const dDir = ftt(1.5, 0.0);
    const dAmb = ftt(0.0, 1.1);
    const dCam = ftt(0.0, 0.4);

    // Rink endpoint — moody. We pull ambient/hemi/dir LOWER than before so the
    // contrast between bright neon and dark base reads as proper rink moodiness
    // (was "neon plus a fair amount of general fill" — too washed-out).
    let rHemi, rDir;
    if (activeCard) {
      // Pre-parsed Color objects (set once in buildCard) — copy() is a 3-float
      // memcpy versus set('#abcdef') which re-parses the hex on every frame.
      _scratchA.copy(activeCard.userData.accentCol);
      _scratchB.copy(activeCard.userData.bgCol);
      _scratchC.copy(activeCard.userData.altCol);
      const cycle = (Math.sin(t * 1.5) + 1) / 2;
      _rColor1.lerpColors(_scratchA, _scratchB, cycle);
      _rColor2.lerpColors(_scratchB, _scratchC, 1 - cycle);
      rHemi = ftt(0.05, 0.0);
      rDir = ftt(0.05, 0.0);
    } else {
      _rColor1.setHSL((t * 0.1) % 1, 0.95, 0.55);
      _rColor2.setHSL(((t * 0.1) + 0.5) % 1, 0.95, 0.55);
      rHemi = ftt(0.15, 0.0);
      rDir = ftt(0.25, 0.0);
    }

    const targetHemi = dHemi * (1 - L) + rHemi * L;
    const targetDir = dDir * (1 - L) + rDir * L;
    const targetAmbient = dAmb * (1 - L); // rink contributes 0
    const targetCamLight = dCam * (1 - L);
    hemiLight.intensity += (targetHemi - hemiLight.intensity) * 0.05;
    dirLight.intensity += (targetDir - dirLight.intensity) * 0.05;
    ambientLight.intensity += (targetAmbient - ambientLight.intensity) * 0.05;
    ambientLight.color.lerp(_ambientWarm, 0.05);
    cameraLight.intensity += (targetCamLight - cameraLight.intensity) * 0.05;
    cameraLight.color.lerp(_camLightWarm, 0.05);

    _tColor1.lerpColors(_dColor1, _rColor1, L);
    _tColor2.lerpColors(_dColor2, _rColor2, L);

    // `az` already cached at the top of the frame.
    dirLight.position.set(Math.sin(az) * 100, 100, Math.cos(az) * 100);
    // Position the amber up and ~70° off to the right of the camera, aimed at
    // origin → light travels diagonally down from upper-right to lower-left
    // across the cards. Grazes instead of washing.
    const azOff = az + Math.PI / 2.5;
    fillFrontAmber.position.set(Math.sin(azOff) * 35, 22, Math.cos(azOff) * 35);
    pointLight1.color.lerp(_tColor1, 0.03);
    neonTop.material.color.lerp(_tColor1, 0.03);
    neonTop.material.emissive.lerp(_tColor1, 0.03);
    pointLight2.color.lerp(_tColor2, 0.03);
    neonBot.material.color.lerp(_tColor2, 0.03);
    neonBot.material.emissive.lerp(_tColor2, 0.03);
    if (activeCard) {
      // Cross-fade LEDs when the active card changes: fade out at the old
      // location, jump to the new location while dark, fade back in. No more
      // flicker from an instant teleport.
      if (ledCard !== activeCard) {
        // Fading out
        localLed1.intensity += (0 - localLed1.intensity) * 0.2;
        localLed2.intensity += (0 - localLed2.intensity) * 0.2;
        if (localLed1.intensity < 0.05) {
          ledMoveTo(activeCard);
          ledCard = activeCard;
        }
      } else {
        // Parked at the right card — fade in
        localLed1.intensity += (5.0 - localLed1.intensity) * 0.1;
        localLed2.intensity += (5.0 - localLed2.intensity) * 0.1;
      }
      _scratchA.copy(activeCard.userData.accentCol);
      _ledTgt.copy(_ledBase).lerp(_scratchA, 0.15);
      ledMat.color.lerp(_ledTgt, 0.1);
      localLed1.color.lerp(_ledTgt, 0.1);
      localLed2.color.lerp(_ledTgt, 0.1);

      // Multiple staggered tracker pairs sweep both directions under the rim.
      const TRACKER_SPEED = 0.4; // cycles per second
      const thetaActive = activeCard.userData.theta;
      for (const tr of trackers) {
        tr.light.visible = true;
        tr.bead.visible = true;
        tr.halo.visible = true;
        const progress = (t * TRACKER_SPEED + tr.offset) % 1;
        const ang = thetaActive + tr.dir * Math.PI * (1 - progress);
        const x = Math.sin(ang) * TRACKER_R;
        const z = Math.cos(ang) * TRACKER_R;
        tr.light.position.set(x, TRACKER_Y, z);
        tr.bead.position.set(x, TRACKER_Y, z);
        tr.halo.position.set(x, TRACKER_Y, z);
        // PointLight with decay=2 + short distance falls off quickly, so we
        // need a meaningful intensity to actually show up on the card. Base
        // 8 cd with a +16 burst at the convergence moment.
        tr.light.intensity = 8 + Math.sin(progress * Math.PI) * 16;
        tr.light.color.lerp(_ledTgt, 0.1);
        // Halo pulses with the same convergence rhythm — softer at the
        // start/end of each cycle, brighter as the two trackers meet.
        const haloPulse = 0.6 + Math.sin(progress * Math.PI) * 0.6;
        tr.halo.material.opacity = haloPulse;
      }
    } else {
      localLed1.intensity += -localLed1.intensity * 0.1;
      localLed2.intensity += -localLed2.intensity * 0.1;
      if (localLed1.intensity < 0.05) ledCard = null;
      for (const tr of trackers) {
        // visible=false skips the light entirely in WebGLLights — no per-frag
        // cost while the deck has no active card.
        tr.light.visible = false;
        tr.light.intensity = 0;
        tr.bead.visible = false;
        tr.halo.visible = false;
      }
    }

    // Queue indicator fade — per-cell shader intensity lerp. Uses the same
    // factors as the active card's LEDs (0.1 in, 0.2 out). Each atlas tracks
    // a `highlightDirty` flag so we skip the loop entirely once every cell
    // has reached its target.
    for (const atlas of atlases) {
      if (!atlas.highlightDirty) continue;
      const cur = atlas.highlightCurrent;
      const tgt = atlas.highlightTarget;
      let stillFading = false;
      for (let i = 0; i < atlas.capacity; i++) {
        const target = tgt[i];
        const current = cur[i];
        if (target === current) continue;
        const factor = target > current ? 0.1 : 0.2;
        const next = current + (target - current) * factor;
        // Snap to target once we're within a half percent, otherwise the
        // dirty flag could oscillate forever as we asymptotically approach.
        if (Math.abs(target - next) < 0.005) {
          cur[i] = target;
        } else {
          cur[i] = next;
          stillFading = true;
        }
      }
      atlas.highlightAttr.needsUpdate = true;
      atlas.highlightDirty = stillFading;
    }

    // The previous back-of-drum cull (one JS loop hiding ~40% of cards each
    // frame) is gone — with all cards now in one InstancedMesh there's no
    // per-card draw-call cost left to claw back. The GPU still backface-culls
    // the rear-facing FrontSide planes for free.
    //
    // Shadow refresh trigger. The dirLight tracks the camera azimuth, so the
    // shadow projection changes whenever az changes; the drum rotation moves
    // every card so the shadow casters move with groupRot. When both are still,
    // the previous shadow map is still mathematically correct — skip the pass.
    // placeIncoming() force-triggers an update by NaN-ing lastShadowAz.
    const groupRot = jukeboxGroup.rotation.y;
    if (Math.abs(az - lastShadowAz) > SHADOW_MOVEMENT_EPS ||
        Math.abs(groupRot - lastShadowGroupRot) > SHADOW_MOVEMENT_EPS ||
        Number.isNaN(lastShadowAz)) {
      dirLight.shadow.needsUpdate = true;
      lastShadowAz = az;
      lastShadowGroupRot = groupRot;
    }
    renderer.render(scene, camera);
  }
  animate();

  return () => {
    cancelAnimationFrame(raf);
    cancelLongPress();
    if (pollInterval !== null) clearInterval(pollInterval);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('resize', scheduleResize);
    window.removeEventListener('orientationchange', scheduleResize);
    window.removeEventListener('pageshow', scheduleResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.visualViewport?.removeEventListener('resize', scheduleResize);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    renderer.domElement.removeEventListener('wheel', onWheel);
    disposeAudio();

    // Walk the scene graph and dispose every GPU resource. WebGL leaks
    // textures/buffers per route change without this — renderer.dispose()
    // alone only frees the GL context.
    scene.traverse((obj) => {
      if (obj.geometry?.dispose) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      for (const m of mats) {
        for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'envMap']) {
          if (m[k]?.dispose) m[k].dispose();
        }
        if (m.dispose) m.dispose();
      }
    });
    if ((scene).environment?.dispose) (scene).environment.dispose();
    if ((scene).background?.dispose) (scene).background.dispose();
    renderer.dispose();
    container.removeChild(renderer.domElement);
  };
}

export function createJukeboxScene(container, options = {}) {
  const tracks = normalizeTracks(options.tracks)
  const nowItem = options.nowItem ?? null
  const onActiveChange = options.onActiveChange || (() => {})
  const onPlaybackError = options.onPlaybackError || (() => {})
  const mode = {
    lighting: options.lighting ?? 0.5,
    zoom: options.zoom ?? 0,
    spin: options.spin ?? 0,
    debug: !!options.debug,
    showCategories: options.showCategories !== false,
    zoomTight: options.zoomTight ?? 0.95,
    zoomFlat: options.zoomFlat ?? 0,
    audioEnabled: options.audioEnabled !== false,
    shuffle: options.shuffle !== false,
  }
  const rows = clampSceneRows(options.rows ?? 10)
  const dispose = initThree(container, tracks, nowItem, onActiveChange, onPlaybackError, mode, rows)
  return { dispose, mode }
}
