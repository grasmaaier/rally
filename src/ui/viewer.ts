import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildResult, PrinterProfile } from '../core/types';
import { type Placement, plateOffset } from '../core/layout';

export type ViewMode = 'plate' | 'assembly';

interface Theme {
  background: string;
  plate: string;
  gridMinor: string;
  gridMajor: string;
  volume: string;
}

const LIGHT: Theme = { background: '#eef0f2', plate: '#3a3d42', gridMinor: '#4a4e55', gridMajor: '#61666e', volume: '#9aa3ad' };
const DARK: Theme = { background: '#15171a', plate: '#2c2f34', gridMinor: '#393d43', gridMajor: '#4d525a', volume: '#4b525b' };

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
  private theme: Theme = LIGHT;
  private printer: PrinterProfile | null = null;
  private plateCount = 1;
  private section = false;
  private color = '#e8e4dc';
  private lastFitKey = '';

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
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      const moved = this.controls.update();
      if (moved || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
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
    this.needsRender = true;
  }

  setColor(color: string) {
    this.color = color;
    this.content.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      // parts with their own colour (e.g. lamp segments) keep it
      if (m && m.userData.filament && !m.userData.own) {
        m.color.set(m.userData.back ? shade(color, 0.55) : color);
      }
    });
    this.needsRender = true;
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
      this.floor = null;
    }
  }

  private partMaterials(clip: THREE.Plane[] | null, own?: string) {
    const color = own ?? this.color;
    const front = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.0, clippingPlanes: clip ?? [] });
    front.userData.filament = true;
    front.userData.own = !!own;
    if (!clip) return [front];
    const back = new THREE.MeshStandardMaterial({ color: shade(color, 0.55), roughness: 0.9, side: THREE.BackSide, clippingPlanes: clip });
    back.userData.filament = true;
    back.userData.back = true;
    back.userData.own = !!own;
    return [front, back];
  }

  private addPart(geom: THREE.BufferGeometry, matrix: THREE.Matrix4, clipAt: number | null, color?: string) {
    let clip: THREE.Plane[] | null = null;
    if (this.section && clipAt !== null) {
      // cut along the depth: keep world y >= clipAt (the root group is Z-up = world Z-up here)
      clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -clipAt)];
    }
    for (const mat of this.partMaterials(clip, color)) {
      const mesh = new THREE.Mesh(geom, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      this.content.add(mesh);
    }
  }

  show(result: BuildResult, mode: ViewMode, printer: PrinterProfile, placements: Placement[], fitKey: string) {
    this.clearContent();
    this.printer = printer;
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
        this.addPart(geoms[pl.part], m, pl.y, result.parts[pl.part].color);
      }
    } else {
      this.plates.visible = false;
      const box = new THREE.Box3();
      for (const s of result.scene) {
        if (s.kind === 'part') {
          const gb = geoms[s.part].boundingBox!.clone().applyMatrix4(new THREE.Matrix4().fromArray(s.matrix));
          box.union(gb);
        } else {
          box.union(new THREE.Box3(new THREE.Vector3(...s.position), new THREE.Vector3(s.position[0] + s.size[0], s.position[1] + s.size[1], s.position[2] + s.size[2])));
        }
      }
      const cy = (box.min.y + box.max.y) / 2;
      const clip = this.section ? [new THREE.Plane(new THREE.Vector3(0, 1, 0), -cy)] : [];
      for (const s of result.scene) {
        if (s.kind === 'part') {
          this.addPart(geoms[s.part], new THREE.Matrix4().fromArray(s.matrix), cy, result.parts[s.part].color);
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
      // soft floor grid under the assembly
      const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 1.6 + 200;
      const step = size > 2000 ? 100 : 50;
      const n = Math.ceil(size / step / 2) * 2;
      const grid = new THREE.GridHelper(n * step, n, this.theme.gridMajor, this.theme.gridMinor);
      grid.rotation.x = Math.PI / 2;
      grid.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, Math.min(0, box.min.z) - 0.5);
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.5;
      this.floor = grid;
      this.root.add(grid);
    }
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

function shade(hex: string, k: number) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}
