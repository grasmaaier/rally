import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildResult, PrinterProfile } from '../core/types';
import { type Placement, plateOffset } from '../core/layout';

export type ViewMode = 'plate' | 'assembly';

/** How a printed part looks: the filament colour, and whether light shines through it. */
export interface PartLook {
  color: string;
  translucent?: boolean;
  /** Water-clear filament. */
  clear?: boolean;
}

interface Theme {
  background: string;
  plate: string;
  gridMinor: string;
  gridMajor: string;
  volume: string;
}

interface ThemeX extends Theme {
  shadow: number;
  highlight: string;
  hover: string;
  axes: [string, string, string];
}

const LIGHT: ThemeX = {
  background: '#e9eaec', plate: '#3a3d42', gridMinor: '#4a4e55', gridMajor: '#61666e', volume: '#9aa3ad',
  shadow: 0.34, highlight: '#3b82f6', hover: '#93b8f5', axes: ['#d9534f', '#3e9b5c', '#3f6fd8'],
};
const DARK: ThemeX = {
  background: '#17181b', plate: '#2c2f34', gridMinor: '#393d43', gridMajor: '#4d525a', volume: '#4b525b',
  shadow: 0.6, highlight: '#5b9bff', hover: '#3d5f99', axes: ['#ef6b67', '#5cc07c', '#6f97ff'],
};

/** A content object the designer may move temporarily (drag preview). */
export interface ContentItem {
  object: THREE.Object3D;
  /** Part index, or null for reference objects (tube, socket, bulb). */
  part: number | null;
  /** World bounding box of the object as built. */
  box: THREE.Box3;
  /** Matrix as built. */
  base: THREE.Matrix4;
}

/** Three.js viewer working in printer coordinates: millimetres, Z up. */
export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private root = new THREE.Group();
  private plates = new THREE.Group();
  private content = new THREE.Group();
  private floor: THREE.Object3D | null = null;
  private geoms: THREE.BufferGeometry[] = [];
  private needsRender = true;
  private theme: ThemeX = LIGHT;
  private printer: PrinterProfile | null = null;
  private plateCount = 1;
  private section = false;
  private color = '#e8e4dc';
  private lastFitKey = '';
  private looks: (PartLook | undefined)[] = [];
  private partColors: (string | undefined)[] = [];
  private selected = new Set<number>();
  private hovered = new Set<number>();
  private raycaster = new THREE.Raycaster();
  private frameListeners: (() => void)[] = [];
  private previewObj: THREE.Object3D | null = null;
  private triad: SVGSVGElement;
  /** Click (not drag) on the canvas: the part under the pointer, or null for empty space. */
  onPick: ((part: number | null, ev: PointerEvent) => void) | null = null;
  /** Mouse hover over a part (desktop only). */
  onHover: ((part: number | null) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 40000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => (this.needsRender = true));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -1.4, 2.2);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1.5, 1, 0.6);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5f66, 0.6), key, fill);
    this.scene.add(this.root);
    this.root.add(this.plates, this.content);
    this.triad = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.triad.setAttribute('class', 'triad');
    this.triad.setAttribute('viewBox', '-30 -30 60 60');
    this.triad.setAttribute('aria-hidden', 'true');
    host.appendChild(this.triad);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.setupPointer();
    const loop = () => {
      requestAnimationFrame(loop);
      const moved = this.controls.update();
      if (moved || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
        this.drawTriad();
        for (const f of this.frameListeners) {
          try {
            f();
          } catch (err) {
            console.warn(err);
          }
        }
      }
    };
    loop();
  }

  /** Clicks and hover on the canvas (a drag that orbits is not a click). */
  private setupPointer() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; t: number; id: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    });
    el.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 700) return;
      this.onPick?.(this.pick(e.clientX, e.clientY), e);
    });
    let last = 0;
    let pending: PointerEvent | null = null;
    let lastPart: number | null = null;
    const hover = () => {
      const e = pending;
      pending = null;
      if (!e) return;
      last = performance.now();
      const part = this.pick(e.clientX, e.clientY);
      if (part !== lastPart) {
        lastPart = part;
        this.onHover?.(part);
      }
    };
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || e.buttons !== 0 || !this.onHover) return;
      const waiting = pending !== null;
      pending = e;
      if (!waiting) window.setTimeout(hover, Math.max(0, 70 - (performance.now() - last)));
    });
    el.addEventListener('pointerleave', () => {
      pending = null;
      if (lastPart !== null) {
        lastPart = null;
        this.onHover?.(null);
      }
    });
  }

  /** Part index under a screen point (client coordinates), or null. */
  pick(clientX: number, clientY: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    this.content.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && typeof o.userData.part === 'number' && o.visible && !o.userData.back) targets.push(o);
    });
    try {
      const hit = this.raycaster.intersectObjects(targets, false)[0];
      return hit ? (hit.object.userData.part as number) : null;
    } catch {
      return null;
    }
  }

  /** Emphasise the selected parts (and the hovered ones, more subtly). */
  setHighlight(selected: Iterable<number>, hovered: Iterable<number> = []) {
    this.selected = new Set(selected);
    this.hovered = new Set(hovered);
    this.refreshHighlight();
  }

  private refreshHighlight() {
    const sel = new THREE.Color(this.theme.highlight);
    const hov = new THREE.Color(this.theme.hover);
    this.content.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
      if (!m || !m.userData.filament || m.userData.back) return;
      const part = m.userData.part as number;
      if (this.selected.has(part)) {
        m.emissive.copy(sel);
        m.emissiveIntensity = 0.2;
      } else if (this.hovered.has(part)) {
        m.emissive.copy(hov);
        m.emissiveIntensity = 0.13;
      } else {
        m.emissive.setRGB(0, 0, 0);
        m.emissiveIntensity = 1;
      }
    });
    this.needsRender = true;
  }

  /** Called after every rendered frame (camera moves, resizes, new content). */
  addFrameListener(f: () => void) {
    this.frameListeners.push(f);
  }

  requestRender() {
    this.needsRender = true;
  }

  /** Turn camera orbiting off while a handle is dragged. */
  setOrbit(on: boolean) {
    this.controls.enabled = on;
  }

  /** World point → CSS pixels in the viewer (z > 1 = behind the camera). */
  project(v: THREE.Vector3): { x: number; y: number; behind: boolean } {
    const p = v.clone().project(this.camera);
    return { x: ((p.x + 1) / 2) * this.host.clientWidth, y: ((1 - p.y) / 2) * this.host.clientHeight, behind: p.z > 1 };
  }

  /** Horizontal unit vector pointing to the right of the screen. */
  screenRight(): THREE.Vector3 {
    const e = this.camera.matrixWorld.elements;
    const v = new THREE.Vector3(e[0], e[1], 0);
    if (v.lengthSq() < 1e-8) v.set(1, 0, 0);
    return v.normalize();
  }

  /** Printed parts and reference objects as shown (for drag previews). */
  contentItems(): ContentItem[] {
    const out: ContentItem[] = [];
    for (const o of this.content.children) {
      if (o === this.previewObj || o.userData.helper) continue;
      if (!o.userData.base) {
        if (o.matrixAutoUpdate) o.updateMatrix();
        o.userData.base = o.matrix.clone();
      }
      const mesh = o as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry | undefined;
      let box: THREE.Box3;
      if (o.userData.box) box = o.userData.box as THREE.Box3;
      else {
        if (!geo) continue;
        if (!geo.boundingBox) geo.computeBoundingBox();
        box = geo.boundingBox!.clone().applyMatrix4(o.userData.base as THREE.Matrix4);
        o.userData.box = box;
      }
      out.push({ object: o, part: typeof o.userData.part === 'number' ? (o.userData.part as number) : null, box, base: o.userData.base as THREE.Matrix4 });
    }
    return out;
  }

  /** Put a content object back where the build placed it. */
  restoreItem(it: ContentItem) {
    it.object.matrixAutoUpdate = false;
    it.object.matrix.copy(it.base);
    it.object.matrixWorldNeedsUpdate = true;
    it.object.visible = true;
    this.needsRender = true;
  }

  /** Move a content object (matrix applied after its built placement). */
  moveItem(it: ContentItem, m: THREE.Matrix4, visible = true) {
    it.object.matrixAutoUpdate = false;
    it.object.matrix.multiplyMatrices(m, it.base);
    it.object.matrixWorldNeedsUpdate = true;
    it.object.visible = visible;
    this.needsRender = true;
  }

  /** A temporary object (drag preview); replaced by the next call or by new content. */
  setPreview(obj: THREE.Object3D | null) {
    if (this.previewObj) {
      this.content.remove(this.previewObj);
      disposeTree(this.previewObj);
    }
    this.previewObj = obj;
    if (obj) this.content.add(obj);
    this.needsRender = true;
  }

  /** A filament-like material for previews. */
  previewMaterial(color: string): THREE.Material {
    const m = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, metalness: 0 });
    applyLook(m, { color }, false);
    m.emissive.set(this.theme.highlight);
    m.emissiveIntensity = 0.25;
    return m;
  }

  private drawTriad() {
    const t = this.triad;
    if (!t.isConnected) return;
    const e = this.camera.matrixWorldInverse.elements;
    // camera-space x/y of the world axes
    const axes = [0, 1, 2].map((i) => ({ i, x: e[i * 4 + 0], y: e[i * 4 + 1], z: e[i * 4 + 2] }));
    axes.sort((a, b) => a.z - b.z);
    const names = ['X', 'Y', 'Z'];
    t.innerHTML = axes
      .map(({ i, x, y }) => {
        const c = this.theme.axes[i];
        const px = x * 19;
        const py = -y * 19;
        return `<line x1="0" y1="0" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${c}" stroke-width="2" stroke-linecap="round"/><circle cx="${(px * 1.2).toFixed(1)}" cy="${(py * 1.2).toFixed(1)}" r="6" fill="${c}"/><text x="${(px * 1.2).toFixed(1)}" y="${(py * 1.2 + 3).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">${names[i]}</text>`;
      })
      .join('');
  }

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  setTheme(dark: boolean) {
    this.theme = dark ? DARK : LIGHT;
    this.scene.background = new THREE.Color(this.theme.background);
    if (this.printer) this.buildPlates(this.printer, this.plateCount);
    this.refreshHighlight();
    this.needsRender = true;
  }

  /** Default colour for parts without a look or colour of their own. */
  setColor(color: string) {
    this.color = color;
    this.refreshLooks();
  }

  /** Per-part filament looks (index = part index); updates the materials in place. */
  setLooks(looks: (PartLook | undefined)[]) {
    this.looks = looks;
    this.refreshLooks();
  }

  private lookOf(part: number): PartLook {
    return this.looks[part] ?? { color: this.partColors[part] ?? this.color };
  }

  private refreshLooks() {
    this.content.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
      if (m && m.userData.filament) applyLook(m, this.lookOf(m.userData.part as number), !!m.userData.back);
    });
    this.refreshHighlight();
  }

  private buildPlates(p: PrinterProfile, count: number) {
    this.plates.clear();
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      g.position.x = plateOffset(p, i);
      const shape = roundedRectShape(p.x, p.y, 8);
      const plate = new THREE.Mesh(new THREE.ShapeGeometry(shape, 8), new THREE.MeshStandardMaterial({ color: this.theme.plate, roughness: 0.85, metalness: 0.1 }));
      plate.position.z = -0.6;
      g.add(plate);
      const minor: number[] = [];
      const major: number[] = [];
      for (let x = -Math.floor(p.x / 2 / 10) * 10; x <= p.x / 2; x += 10) (x % 50 === 0 ? major : minor).push(x, -p.y / 2, -0.5, x, p.y / 2, -0.5);
      for (let y = -Math.floor(p.y / 2 / 10) * 10; y <= p.y / 2; y += 10) (y % 50 === 0 ? major : minor).push(-p.x / 2, y, -0.5, p.x / 2, y, -0.5);
      g.add(lines(minor, this.theme.gridMinor), lines(major, this.theme.gridMajor));
      // build volume outline
      const v = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(p.x, p.y, p.z)),
        new THREE.LineBasicMaterial({ color: this.theme.volume, transparent: true, opacity: 0.35 }),
      );
      v.position.z = p.z / 2;
      g.add(v);
      this.plates.add(g);
    }
  }

  private clearContent() {
    if (this.previewObj) {
      this.content.remove(this.previewObj);
      disposeTree(this.previewObj);
      this.previewObj = null;
    }
    for (const g of this.geoms) g.dispose();
    this.geoms = [];
    this.content.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
    this.content.clear();
    if (this.floor) {
      this.root.remove(this.floor);
      disposeTree(this.floor);
      this.floor = null;
    }
  }

  private partMaterials(clip: THREE.Plane[] | null, part: number) {
    const look = this.lookOf(part);
    const front = new THREE.MeshPhysicalMaterial({ metalness: 0.0, clippingPlanes: clip ?? [] });
    front.userData.filament = true;
    front.userData.part = part;
    applyLook(front, look, false);
    if (!clip) return [front];
    const back = new THREE.MeshPhysicalMaterial({ side: THREE.BackSide, clippingPlanes: clip });
    back.userData.filament = true;
    back.userData.back = true;
    back.userData.part = part;
    applyLook(back, look, true);
    return [front, back];
  }

  private addPart(geom: THREE.BufferGeometry, matrix: THREE.Matrix4, clipAt: number | null, part: number) {
    let clip: THREE.Plane[] | null = null;
    if (this.section && clipAt !== null) {
      // cut along the depth: keep world y >= clipAt (the root group is Z-up = world Z-up here)
      clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -clipAt)];
    }
    for (const mat of this.partMaterials(clip, part)) {
      const mesh = new THREE.Mesh(geom, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.userData.part = part;
      if (mat.userData.back) mesh.userData.back = true;
      this.content.add(mesh);
    }
  }

  /** A see-through reference model (e.g. the uploaded object a cover or stand is made for). */
  private addGhostMesh(data: { positions: Float32Array; indices: Uint32Array }, color: string) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeVertexNormals();
    this.geoms.push(geo);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
    this.content.add(new THREE.Mesh(geo, mat));
  }

  show(result: BuildResult, mode: ViewMode, printer: PrinterProfile, placements: Placement[], fitKey: string, looks?: (PartLook | undefined)[]) {
    this.clearContent();
    this.printer = printer;
    this.partColors = result.parts.map((p) => p.color);
    if (looks) this.looks = looks;
    const geoms = result.parts.map((p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(p.mesh.indices, 1));
      const out = p.triangles > 400000 ? flat(g) : toCreasedNormals(g, Math.PI / 6);
      if (out !== g) g.dispose();
      out.computeBoundingBox();
      return out;
    });
    this.geoms = geoms;
    if (mode === 'plate' || !result.scene) {
      this.plateCount = Math.max(1, ...placements.map((p) => p.plate + 1));
      this.buildPlates(printer, this.plateCount);
      this.plates.visible = true;
      for (const pl of placements) {
        const m = new THREE.Matrix4().makeTranslation(pl.x + plateOffset(printer, pl.plate), pl.y, 0);
        if (pl.rotated) m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
        this.addPart(geoms[pl.part], m, pl.y, pl.part);
      }
    } else {
      this.plates.visible = false;
      const box = new THREE.Box3();
      for (const s of result.scene) {
        if (s.kind === 'part') {
          const gb = geoms[s.part].boundingBox!.clone().applyMatrix4(new THREE.Matrix4().fromArray(s.matrix));
          box.union(gb);
        } else if (s.kind === 'mesh') {
          box.union(new THREE.Box3().setFromArray(s.mesh.positions));
        } else {
          box.union(new THREE.Box3(new THREE.Vector3(...s.position), new THREE.Vector3(s.position[0] + s.size[0], s.position[1] + s.size[1], s.position[2] + s.size[2])));
        }
      }
      const cy = (box.min.y + box.max.y) / 2;
      const clip = this.section ? [new THREE.Plane(new THREE.Vector3(0, 1, 0), -cy)] : [];
      for (const s of result.scene) {
        if (s.kind === 'part') {
          this.addPart(geoms[s.part], new THREE.Matrix4().fromArray(s.matrix), cy, s.part);
        } else if (s.kind === 'mesh') {
          this.addGhostMesh(s.mesh, s.color);
        } else {
          const geo = new THREE.BoxGeometry(...s.size);
          this.geoms.push(geo);
          const pos = new THREE.Vector3(s.position[0] + s.size[0] / 2, s.position[1] + s.size[1] / 2, s.position[2] + s.size[2] / 2);
          if (s.material === 'ghost') {
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: s.color, transparent: true, opacity: 0.6 }));
            edges.position.copy(pos);
            const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide }));
            fill.position.copy(pos);
            this.content.add(edges, fill);
          } else {
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.78, metalness: 0, clippingPlanes: clip }));
            mesh.position.copy(pos);
            this.content.add(mesh);
          }
        }
      }
      // the model floats over a soft contact shadow (no grid)
      const w = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 40);
      const floorZ = Math.min(0, box.min.z) - 0.5;
      const shadow = new THREE.Mesh(
        new THREE.PlaneGeometry(w * 1.9, w * 1.9),
        new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: this.theme.shadow, toneMapped: false, color: 0x000000 }),
      );
      shadow.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, floorZ);
      shadow.renderOrder = -1;
      shadow.userData.helper = true;
      this.floor = shadow;
      this.root.add(shadow);
    }
    this.refreshHighlight();
    if (fitKey !== this.lastFitKey) {
      this.lastFitKey = fitKey;
      this.fit(mode === 'plate' || !result.scene);
    }
    this.needsRender = true;
  }

  setSection(on: boolean) {
    this.section = on;
  }

  /** Frame the content (and the plate in plate mode). */
  fit(includePlate = this.plates.visible) {
    const box = new THREE.Box3().setFromObject(this.content);
    if (box.isEmpty()) return;
    if (includePlate) {
      // frame the parts, but keep some of the plate in view for scale
      const c = box.getCenter(new THREE.Vector3());
      const min = 110;
      box.expandByPoint(new THREE.Vector3(c.x - min / 2, c.y - min / 2, 0));
      box.expandByPoint(new THREE.Vector3(c.x + min / 2, c.y + min / 2, min / 3));
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = size.length() / 2;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * (this.camera.aspect < 1 ? 1.25 / this.camera.aspect : 1.05);
    const dir = new THREE.Vector3(0.55, -1, 0.7).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.5, dist / 200);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.needsRender = true;
  }

  view(dir: 'front' | 'top' | 'iso') {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    const d = dir === 'front' ? new THREE.Vector3(0, -1, 0.08) : dir === 'top' ? new THREE.Vector3(0, -0.001, 1) : new THREE.Vector3(0.55, -1, 0.7);
    this.camera.position.copy(target).addScaledVector(d.normalize(), dist);
    this.controls.update();
    this.needsRender = true;
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

let shadowTex: THREE.Texture | null = null;

/** Radial gradient for the contact shadow (shared). */
function shadowTexture(): THREE.Texture {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.28, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.62, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  shadowTex = new THREE.CanvasTexture(c);
  // the texture is used as alpha through the white→transparent gradient
  return shadowTex;
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((y) => y.dispose());
    else mat?.dispose();
  });
}

function lines(pts: number[], color: string) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
}

function roundedRectShape(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function flat(g: THREE.BufferGeometry) {
  const n = g.toNonIndexed();
  n.computeVertexNormals();
  return n;
}

/** Opaque filament is a satin plastic; translucent filament lets light through (transmission). */
export function applyLook(m: THREE.MeshPhysicalMaterial, look: PartLook, back: boolean) {
  const see = !!(look.translucent || look.clear);
  if (back) {
    // the cut face in section view
    m.color.set(shade(look.color, 0.55));
    m.roughness = 0.9;
    m.transmission = 0;
    m.transparent = see;
    m.opacity = see ? 0.75 : 1;
  } else {
    m.color.set(look.color);
    m.roughness = see ? (look.clear ? 0.08 : 0.32) : 0.5;
    m.transmission = see ? (look.clear ? 0.95 : 0.65) : 0;
    m.thickness = see ? 1.2 : 0;
    m.ior = 1.5;
    m.attenuationColor.set(look.color);
    m.attenuationDistance = look.clear ? 400 : 40;
    m.transparent = false;
    m.opacity = 1;
  }
  m.needsUpdate = true;
}

function shade(hex: string, k: number) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}
