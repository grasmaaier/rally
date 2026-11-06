import type { CrossSection, Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import type { BuildOutput, InfoBlock, Params, PrinterProfile, SceneItem, ToolDef } from '../core/types';
import { UserError, num, str } from '../core/types';
import { fitsOn, usable } from '../core/printer';
import { clamp, countersunk, mul, rotX, rotZ, roundedRect, SCREWS, teardrop, translation } from '../geom/helpers';
import { csOf, loftLoop, loopsOf, meanderPath, pillowPrism, resample, ribbon, soften, softCavity, softenOnBed, softPrism, surfaceTexture, unitNormals } from '../geom/soft';

const is = (...types: string[]) => (p: Params) => types.includes(str(p, 'type'));
const penRound = (p: Params) => ['cup', 'plus'].includes(str(p, 'penLayout'));
const LOOKS = [
  { value: 'flutes', label: 'Fijne verticale ribbels' },
  { value: 'rings', label: 'Horizontale ribbels' },
  { value: 'bubbles', label: 'Bobbels' },
  { value: 'twist', label: 'Gedraaide ribbels' },
  { value: 'bulge', label: 'Gestapelde bollen' },
  { value: 'pills', label: 'Pillen met knoppen' },
  { value: 'smooth', label: 'Glad' },
];
const laptop = (style: string) => (p: Params) => is('laptop')(p) && str(p, 'laptopStyle') === style;

function sizeOf(solid: Manifold): [number, number, number] {
  const b = solid.boundingBox();
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function ensureFits(solid: Manifold, printer: PrinterProfile, name: string) {
  const size = sizeOf(solid);
  if (!fitsOn(printer, size)) {
    const u = usable(printer);
    throw new UserError(`${name} is ${size.map((v) => v.toFixed(0)).join(' × ')} mm en past niet op de ${printer.name} (${u.x.toFixed(0)} × ${u.y.toFixed(0)} × ${u.z.toFixed(0)} mm).`);
  }
}

const rect = (M: ManifoldToplevel, x0: number, y0: number, x1: number, y1: number) => M.CrossSection.square([x1 - x0, y1 - y0]).translate([x0, y0]);
const circle = (M: ManifoldToplevel, r: number, [x, y]: Vec2) => M.CrossSection.circle(r, 64).translate([x, y]);
/** Keep faces that point down (bed) or back (wall) flat when pillowing a profile. */
const notOnBed = (n: Vec2) => clamp((n[1] + 0.92) / 0.4, 0, 1);
const notOnBedOrWall = (n: Vec2) => notOnBed(n) * clamp((n[0] + 0.92) / 0.4, 0, 1);

// ---- soap dish ---------------------------------------------------------------

function soapOutline(M: ManifoldToplevel, shape: string, w: number, d: number): CrossSection {
  if (shape === 'pill') return roundedRect(M, w, d, d / 2 - 0.01, 32);
  if (shape !== 'wave') return roundedRect(M, w, d, Math.min(w, d) * 0.3, 32);
  // big soft scallops around the rim, like a flower-shaped dish
  const amp = clamp(Math.min(w, d) * 0.035, 1.5, 3.5);
  const loop = resample(loopsOf(roundedRect(M, w - 2 * amp, d - 2 * amp, Math.min(w, d) * 0.3, 32)).outers[0], 0.5);
  const normals = unitNormals(loop);
  const count = Math.max(8, Math.round((loop.length * 0.5) / 22));
  return csOf(M, [loop.map(([x, y], i) => {
    const o = amp * Math.cos((2 * Math.PI * count * i) / loop.length);
    return [x + normals[i][0] * o, y + normals[i][1] * o] as Vec2;
  })]);
}

function soapDish(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const w = num(p, 'soapW');
  const d = num(p, 'soapD');
  const h = num(p, 'soapH');
  const n = Math.round(num(p, 'soapRibs'));
  const fluted = str(p, 'soapTexture') === 'flutes';
  const wall = 3;
  const bottom = 2.4;
  const fl = fluted ? { pitch: 3.2, depth: 0.8 } : undefined;
  const outline = soapOutline(M, str(p, 'soapShape'), w - (fl ? 2 * fl.depth : 0), d - (fl ? 2 * fl.depth : 0));
  // the floor cove needs crests at least that round, or the offset outline folds
  const cove = str(p, 'soapShape') === 'wave' ? 2.5 : Math.min(6, h / 3);
  const cavity = soften(outline.offset(-wall, 'Round', 2, 48), cove + 0.6, 0);
  let solid = softPrism(M, outline, h, { rTop: 1.3, chamfer: 0.6, flute: fl });
  solid = solid.subtract(softCavity(M, cavity, bottom, h, 1.3, cove));

  // raised wavy ribs keep the soap dry; their tops are fully rounded
  const inner = cavity.offset(-2.5, 'Round', 2, 48);
  const ib = inner.bounds();
  const span = ib.max[0] - ib.min[0] - 8;
  const innerD = ib.max[1] - ib.min[1];
  const pitchX = span / Math.max(1, n - 1);
  const rw = clamp(pitchX * 0.36, 2.4, 4.5);
  const amp = clamp(pitchX * 0.22, 1, 3.5);
  const wave = innerD * 0.6;
  const xs = Array.from({ length: n }, (_, i) => (n === 1 ? 0 : -span / 2 + pitchX * i) + (ib.max[0] + ib.min[0]) / 2);
  const paths = xs.map((x) => Array.from({ length: Math.ceil(d / 0.8) + 1 }, (_, k) => {
    const y = -d / 2 + k * 0.8;
    return [x + amp * Math.sin((2 * Math.PI * y) / wave), y] as Vec2;
  }));
  const ribsCs = soften(M.CrossSection.union(paths.map((path) => ribbon(M, path, rw))).intersect(inner), rw * 0.49, 0);
  const ribH = clamp(h * 0.22, 2.5, 5);
  solid = solid.add(softPrism(M, ribsCs, ribH + 0.6, { rTop: rw * 0.45 }).translate([0, 0, bottom - 0.6]));

  let drains = 0;
  if (str(p, 'soapDrain') !== 'none') {
    const safe = inner.offset(-2, 'Round', 2, 48);
    const holes: Manifold[] = [];
    for (let i = 0; i < n - 1; i++) {
      for (const y of [0, -wave / 2, wave / 2]) {
        const c: Vec2 = [(xs[i] + xs[i + 1]) / 2 + amp * Math.sin((2 * Math.PI * y) / wave), y];
        if (circle(M, 1.8, c).subtract(safe).area() > 1e-3) continue;
        holes.push(M.Manifold.cylinder(bottom + 1, 1.8, 1.8, 24).translate([c[0], c[1], -0.5]));
      }
    }
    drains = holes.length;
    if (holes.length) solid = solid.subtract(M.Manifold.union(holes));
  }
  ensureFits(solid, printer, 'De zeepschaal');
  const [sx, sy] = sizeOf(solid);
  return {
    parts: [{ name: 'Golfzeepschaal', solid, material: 'petg-hf' }],
    info: [{ kind: 'kv', title: 'Maat', rows: [['Schaal', `${sx.toFixed(0)} × ${sy.toFixed(0)} × ${h.toFixed(0)} mm`], ['Golfribbels', `${n}`], ['Afwatering', drains ? `${drains} gaatjes tussen de ribbels` : 'geen (dichte bodem)']] }],
    tips: [
      'Print de schaal plat op de bodem. De golfribbels en de afgeronde rand printen zonder support.',
      drains ? 'Het water loopt via de gaatjes weg: zet de schaal op een tegel of in de douche.' : 'Zonder gaatjes blijft het water in de schaal: spoel hem af en toe om.',
    ],
  };
}

// ---- pen organizer -------------------------------------------------------------

function penCenters(layout: string, n: number, R: number, s: number): Vec2[] {
  if (layout === 'cluster' && n >= 3) {
    const ring = s / (2 * Math.sin(Math.PI / n));
    return Array.from({ length: n }, (_, i) => {
      const a = Math.PI / 2 + (2 * Math.PI * i) / n;
      return [ring * Math.cos(a), ring * Math.sin(a)] as Vec2;
    });
  }
  if (layout === 'zigzag' && n >= 2) {
    const dy = R * 0.45;
    const dx = Math.sqrt(Math.max(1, s * s - 4 * dy * dy));
    return Array.from({ length: n }, (_, i) => [(i - (n - 1) / 2) * dx, i % 2 ? dy : -dy] as Vec2);
  }
  return Array.from({ length: n }, (_, i) => [(i - (n - 1) / 2) * s, 0] as Vec2);
}

/** Round beaker with straight dividers, or a plus-shaped pot on a round foot. */
function penCupOrPlus(M: ManifoldToplevel, p: Params, printer: PrinterProfile, layout: string): BuildOutput {
  const Dc = num(p, 'penCupD');
  const h = num(p, 'penH');
  const wall = num(p, 'penWall');
  const kind = str(p, 'penLook');
  const fluted = kind !== 'smooth';
  const bottom = 2.4;
  const R = Dc / 2;
  const rRim = Math.min(wall * 0.4, 1.1);
  let outline: CrossSection;
  let cavity: CrossSection;
  let cells: number;
  let solid: Manifold;
  if (layout === 'plus') {
    const a = Dc * 0.42;
    const arm = roundedRect(M, a, Dc, a * 0.3, 32);
    outline = soften(arm.add(arm.rotate(90)), 0, a * 0.3);
    cavity = soften(outline.offset(-wall, 'Round', 2, 48), Math.min(3, a / 4), 0);
    cells = 1;
    solid = softPrism(M, outline, h, { rTop: rRim, chamfer: 0.6, texture: lookOf(kind, h, rRim, 0.6) });
    // a round foot like a saucer, wider than the arms
    const foot = softPrism(M, M.CrossSection.circle(R + 2 + reliefOf(kind), 128), 4, { rTop: 1.6, chamfer: 0.6 });
    solid = solid.add(foot);
  } else {
    cells = clamp(Math.round(num(p, 'penCells')), 1, 4);
    outline = M.CrossSection.circle(R, 160);
    const ri = R - wall;
    const dividers: CrossSection[] = [];
    if (cells === 2) dividers.push(rect(M, -wall / 2, -ri - 1, wall / 2, ri + 1));
    if (cells === 3) {
      // one full wall plus a half wall, like a peace sign without the ring
      dividers.push(rect(M, -ri - 1, -wall / 2, ri + 1, wall / 2), rect(M, -wall / 2, -ri - 1, wall / 2, 0));
    }
    if (cells === 4) dividers.push(rect(M, -wall / 2, -ri - 1, wall / 2, ri + 1), rect(M, -ri - 1, -wall / 2, ri + 1, wall / 2));
    cavity = M.CrossSection.circle(ri, 160);
    if (dividers.length) cavity = soften(cavity.subtract(M.CrossSection.union(dividers)), 2.5, 0);
    solid = softPrism(M, outline, h, { rTop: rRim, chamfer: 1.2, texture: lookOf(kind, h, rRim, 1.2) });
  }
  solid = solid.subtract(softCavity(M, cavity, bottom, h, rRim, Math.min(5, Dc * 0.06)));
  ensureFits(solid, printer, 'De pennenbak');
  const [sx, sy] = sizeOf(solid);
  return {
    parts: [{ name: layout === 'plus' ? 'Pluspot' : 'Vakkenbeker', solid, material: 'pla-matte' }],
    info: [{ kind: 'kv', title: 'Indeling', rows: [['Vakken', `${cells}`], ['Diepte', `${(h - bottom).toFixed(0)} mm`], ['Buitenmaat', `${sx.toFixed(0)} × ${sy.toFixed(0)} × ${h.toFixed(0)} mm`]] }],
    tips: [
      layout === 'plus'
        ? 'Print rechtop op de ronde voet: de plusvorm en de holle vakken printen zonder support.'
        : 'Print rechtop: de tussenwanden lopen tot aan de rand en printen zonder support.',
      fluted ? 'Het reliëf komt het mooist uit met PLA Matte en de naad aan de achterkant.' : 'Gladde wanden zie je het best met een matte of zijdeglans filament.',
    ],
  };
}

function penOrganizer(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  if (['cup', 'plus'].includes(str(p, 'penLayout'))) return penCupOrPlus(M, p, printer, str(p, 'penLayout'));
  const n = Math.round(num(p, 'penCells'));
  const D = num(p, 'penCellD');
  const h = num(p, 'penH');
  const wall = num(p, 'penWall');
  const layout = str(p, 'penLayout');
  const kind = str(p, 'penLook');
  const fluted = kind !== 'smooth';
  const open = str(p, 'penCavity') === 'open';
  const bottom = 2.4;
  const R = D / 2;
  const s = 2 * R - wall;
  const centers = penCenters(layout, n, R, s);
  const blobs = centers.map((c) => circle(M, R, c));
  const cluster = layout === 'cluster' && n >= 3;
  if (cluster) blobs.push(M.CrossSection.hull(centers.map((c) => circle(M, 1, c))));
  const outline = soften(M.CrossSection.union(blobs), 0, R * 0.35);
  const rRim = Math.min(wall * 0.4, 1.1);
  let solid = softPrism(M, outline, h, { rTop: rRim, chamfer: 0.6, texture: lookOf(kind, h, rRim, 0.6) });
  const cells = open
    ? [outline.offset(-wall, 'Round', 2, 48)]
    : centers.map((c) => circle(M, R - wall, c));
  if (cluster && !open) {
    const ring = Math.hypot(centers[0][0], centers[0][1]);
    if (ring - R > 7) cells.push(circle(M, ring - R, [0, 0]));
  }
  solid = solid.subtract(M.Manifold.union(cells.map((cs) => softCavity(M, cs, bottom, h, rRim, Math.min(6, R * 0.3)))));
  ensureFits(solid, printer, 'De pennenbak');
  const [sx, sy] = sizeOf(solid);
  return {
    parts: [{ name: 'Golfpennenbak', solid, material: 'pla-matte' }],
    info: [{ kind: 'kv', title: 'Indeling', rows: [['Vakken', open ? '1 doorlopend golfvak' : `${cells.length}`], ['Vak', `Ø${(D - 2 * wall).toFixed(0)} mm, ${(h - bottom).toFixed(0)} mm diep`], ['Buitenmaat', `${sx.toFixed(0)} × ${sy.toFixed(0)} × ${h.toFixed(0)} mm`]] }],
    tips: [
      'Print rechtop op de bodem: de ronde vakken, de golvende buitenkant en de ribbels printen zonder support.',
      fluted ? 'De fijne ribbels komen het mooist uit met PLA Matte en de naad aan de achterkant.' : 'Gladde wanden zie je het best met een matte of zijdeglans filament.',
    ],
  };
}

// ---- monitor riser -------------------------------------------------------------

/** Side profile of one arch foot: x across, y up (in use). */
function archProfile(M: ManifoldToplevel, W: number, H: number) {
  const rb = 3;
  const Rt = clamp((W - 30) / 2, 6, H * 0.45);
  const outer = M.CrossSection.hull([
    circle(M, rb, [-W / 2 + rb, rb]),
    circle(M, rb, [W / 2 - rb, rb]),
    circle(M, Rt, [-W / 2 + Rt, H - Rt]),
    circle(M, Rt, [W / 2 - Rt, H - Rt]),
  ]);
  const topT = clamp(H * 0.24, 14, 26);
  const leg = clamp(W * 0.2, 10, 22);
  const th = H - topT;
  let tw = W - 2 * leg;
  if (th - tw / 2 < 4) tw = 2 * (th - 4);
  let profile = outer;
  if (tw >= 14) {
    const ra = tw / 2;
    profile = outer.subtract(M.CrossSection.union([rect(M, -ra, -1, ra, th - ra), circle(M, ra, [0, th - ra])]));
  }
  return { profile: soften(profile, 2.5, 0), flatW: W - 2 * Rt, topT, tunnel: tw >= 14 ? tw : 0 };
}

/**
 * Meander foot: one wall of constant thickness folded into hairpins (seen from
 * above), printed upright. The plank rests on all the folds at once.
 */
function meanderFoot(M: ManifoldToplevel, W: number, D: number, H: number, screw: (typeof SCREWS)[string]) {
  const t = 4.5;
  const runs = Math.max(2, Math.floor((D - t) / 24) + 1);
  const s = (D - t) / (runs - 1);
  const L = W - s - t;
  if (L < 6) throw new UserError('De meanderpoot is te smal voor zijn diepte: maak hem breder.');
  const ys = Array.from({ length: runs }, (_, i) => -(D - t) / 2 + i * s);
  const last = (runs - 1) % 2 === 0 ? L / 2 : -L / 2;
  const path = meanderPath(ys, -L / 2, L / 2, -L / 2, last).map(([a, b]) => [b, a] as Vec2);
  // round bosses on the front and back fold carry the screws
  const bossR = screw.pilot / 2 + 3;
  const bosses = [ys[0], ys[runs - 1]].map((y) => circle(M, bossR, [0, y]));
  const plan = soften(ribbon(M, path, t).add(M.CrossSection.union(bosses)), 0, 2);
  let foot = softPrism(M, plan, H, { rTop: 1.2, chamfer: 0.6 });
  const holeDepth = 22;
  for (const y of [ys[0], ys[runs - 1]]) {
    foot = foot.subtract(M.Manifold.cylinder(holeDepth + 1, screw.pilot / 2, screw.pilot / 2, 24).translate([0, y, H - holeDepth]));
  }
  return { foot, holes: 2, holeDepth, folds: runs };
}

function monitorRiser(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const boardW = num(p, 'monitorBoardW');
  const boardD = num(p, 'monitorBoardD');
  const boardT = num(p, 'monitorBoardT');
  const H = num(p, 'monitorH');
  const W = num(p, 'monitorFootW');
  const D = num(p, 'monitorFootD');
  const inset = num(p, 'monitorInset');
  const feet = Number(str(p, 'monitorFeet'));
  if (boardW < 2 * inset + 2 * W + 20) throw new UserError('De plank is te smal voor twee poten met deze breedte en randafstand.');
  if (feet === 4 && boardD < 2 * inset + 2 * D + 10) throw new UserError('De plank is niet diep genoeg voor vier poten: maak de poten minder diep of kies 2 poten.');
  if (feet === 2 && D > boardD) throw new UserError('De poten zijn dieper dan de plank: maak ze minder diep.');

  const screw = SCREWS[str(p, 'monitorScrew')] ?? SCREWS.M4;
  if (str(p, 'monitorStyle') === 'meander') return monitorMeander(M, p, printer, screw);
  const arch = archProfile(M, W, H);
  // printed on its side: the arch lies flat, the flutes run along the print height
  let foot = softPrism(M, arch.profile, D, {
    rTop: 3.5,
    chamfer: 1,
    flute: { pitch: 4, depth: 0.9, weight: (n) => clamp((0.93 - Math.abs(n[1])) / 0.25, 0, 1) },
  });
  const holeXs = arch.flatW >= 40 ? [-arch.flatW * 0.25, arch.flatW * 0.25] : [0];
  const holeDepth = arch.topT - 3;
  for (const x of holeXs) {
    foot = foot.subtract(teardrop(M, screw.pilot / 2, 32).extrude(holeDepth + 0.1).rotate([90, 0, 0]).translate([x, H + 0.1, D / 2]));
  }
  ensureFits(foot, printer, 'Een boogpoot');

  const xs = [-boardW / 2 + inset + W / 2, boardW / 2 - inset - W / 2];
  const ys = feet === 4 ? [-boardD / 2 + inset + D / 2, boardD / 2 - inset - D / 2] : [0];
  const positions = xs.flatMap((x) => ys.map((y) => [x, y] as const));
  const scene: SceneItem[] = positions.map(([x, y]) => ({ kind: 'part', part: 0, matrix: mul(translation(x, y + D / 2, 0), rotX(90)) }));
  scene.push({ kind: 'box', size: [boardW, boardD, boardT], position: [-boardW / 2, -boardD / 2, H], color: '#b98b5f', material: 'wood', label: 'Je plank' });
  const screws = positions.length * holeXs.length;
  return {
    parts: [{ name: 'Boogpoot', solid: foot, quantity: positions.length, material: 'petg-hf' }],
    scene,
    defaultView: 'assembly',
    info: [
      {
        kind: 'table',
        title: 'Benodigdheden',
        headers: ['Onderdeel', 'Aantal', 'Maat'],
        rows: [
          ['Geprinte boogpoot', positions.length, `${W.toFixed(0)} × ${D.toFixed(0)} × ${H.toFixed(0)} mm`],
          ['Plank', 1, `${boardW.toFixed(0)} × ${boardD.toFixed(0)} × ${boardT.toFixed(0)} mm`],
          [`Zelftappende ${screw.label}-schroef`, screws, `${Math.ceil(boardT + holeDepth - 2)} mm lang`],
        ],
      },
      { kind: 'kv', title: 'Kabeltunnel', rows: [['Doorgang onder elke poot', arch.tunnel ? `${arch.tunnel.toFixed(0)} mm breed` : 'geen (poot te smal)']] },
    ],
    tips: [
      'Elke poot print op zijn zijkant: de boog ligt plat op het bed, dus geen support en sterke lagen. De fijne ribbels lopen van voor naar achter.',
      'Leg de plank op de poten, boor van boven gaatjes voor in de plank en schroef hem vast. Gebruik de tunnels om kabels onder de plank door te leiden.',
      'De getoonde plank is alleen een voorbeeld; exporteer alleen de geprinte poten.',
    ],
  };
}

function monitorMeander(M: ManifoldToplevel, p: Params, printer: PrinterProfile, screw: (typeof SCREWS)[string]): BuildOutput {
  const boardW = num(p, 'monitorBoardW');
  const boardD = num(p, 'monitorBoardD');
  const boardT = num(p, 'monitorBoardT');
  const H = num(p, 'monitorH');
  const W = num(p, 'monitorFootW');
  const D = Math.min(num(p, 'monitorFootD'), boardD);
  const inset = num(p, 'monitorInset');
  if (boardW < 2 * inset + 2 * W + 20) throw new UserError('De plank is te smal voor twee poten met deze breedte en randafstand.');
  const { foot, holes, holeDepth, folds } = meanderFoot(M, W, D, H, screw);
  ensureFits(foot, printer, 'Een meanderpoot');
  const xs = [-boardW / 2 + inset + W / 2, boardW / 2 - inset - W / 2];
  const scene: SceneItem[] = xs.map((x) => ({ kind: 'part', part: 0, matrix: translation(x, 0, 0) }));
  scene.push({ kind: 'box', size: [boardW, boardD, boardT], position: [-boardW / 2, -boardD / 2, H], color: '#b98b5f', material: 'wood', label: 'Je plank' });
  return {
    parts: [{ name: 'Meanderpoot', solid: foot, quantity: 2, material: 'petg-hf' }],
    scene,
    defaultView: 'assembly',
    info: [
      {
        kind: 'table',
        title: 'Benodigdheden',
        headers: ['Onderdeel', 'Aantal', 'Maat'],
        rows: [
          ['Geprinte meanderpoot', 2, `${W.toFixed(0)} × ${D.toFixed(0)} × ${H.toFixed(0)} mm`],
          ['Plank', 1, `${boardW.toFixed(0)} × ${boardD.toFixed(0)} × ${boardT.toFixed(0)} mm`],
          [`Zelftappende ${screw.label}-schroef`, 2 * holes, `${Math.ceil(boardT + holeDepth - 4)} mm lang`],
        ],
      },
      { kind: 'kv', title: 'Meander', rows: [['Plooien per poot', `${folds}`], ['Wanddikte', '4,5 mm']] },
    ],
    tips: [
      'Print elke poot rechtop: de meanderwand gaat recht omhoog, dus geen support. De plank rust op alle plooien tegelijk.',
      'Boor de plank voor boven de twee ronde schroefbussen en schroef hem van boven vast.',
      'De getoonde plank is alleen een voorbeeld; exporteer alleen de geprinte poten.',
    ],
  };
}

// ---- laptop holder -------------------------------------------------------------

/** Vertical dock: one wall of constant thickness folded into posts and slots (side view). */
function laptopDock(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const slots = Math.round(num(p, 'laptopSlots'));
  const g = num(p, 'laptopSlotW');
  const H = num(p, 'laptopH');
  const D = num(p, 'laptopD');
  const t = num(p, 'laptopWall');
  const P = num(p, 'laptopPostW');
  if (H < P / 2 + g / 2 + 3 * t + 10) throw new UserError('De houder is te laag voor deze sleufbreedte: maak hem hoger.');
  const xs: number[] = [0];
  for (let i = 0; i < slots; i++) xs.push(xs[xs.length - 1] + P - t, xs[xs.length - 1] + P - t + g + t);
  xs.push(xs[xs.length - 1] + P - t);
  const yBot = (g + t) / 2 + t;
  const yTop = H - (P - t) / 2 - t / 2;
  const path = meanderPath(xs, yBot, yTop, t / 2, t / 2);
  const width = xs[xs.length - 1];
  const base = rect(M, -t / 2, 0, width + t / 2, t);
  const profile = soften(ribbon(M, path, t).add(base), t * 0.45, t * 0.8).translate([-width / 2, 0]);
  // printed on its side: the meander lies flat, so every fold prints without support
  const dock = softPrism(M, profile, D, { rTop: Math.min(2, t * 0.45), chamfer: 0.6 });
  ensureFits(dock, printer, 'De laptophouder');
  const [sx] = sizeOf(dock);
  return {
    parts: [{ name: 'Meander-laptophouder', solid: dock, material: 'petg-hf' }],
    scene: [{ kind: 'part', part: 0, matrix: mul(translation(0, D / 2, 0), rotX(90)) }],
    defaultView: 'assembly',
    info: [{ kind: 'kv', title: 'Maat', rows: [['Sleuven', `${slots} × ${g.toFixed(0)} mm breed`], ['Sleufdiepte', `${(yTop - yBot).toFixed(0)} mm`], ['Buitenmaat', `${sx.toFixed(0)} × ${D.toFixed(0)} × ${H.toFixed(0)} mm`]] }],
    tips: [
      'Print op zijn zijkant: de meander ligt plat op het bed en print zonder support. De lagen lopen zo door alle bochten heen, dat maakt hem stevig.',
      'Meet de dikte van je dichte laptop (of tablet) en tel er 2 tot 4 mm bij op voor de sleufbreedte.',
    ],
  };
}

/** Open-laptop stand: two side frames with a wavy web and a bead lip at the front. */
function laptopStand(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const a = (num(p, 'laptopAngle') * Math.PI) / 180;
  const L = num(p, 'laptopLen');
  const yF = num(p, 'laptopFront');
  const W = num(p, 'laptopStandW');
  const t = num(p, 'laptopWall') + 2;
  const lip = num(p, 'laptopLip');
  const yB = yF + L * Math.tan(a);
  const top = (x: number) => yF + x * Math.tan(a);
  const outer = soften(csOf(M, [[[0, 0], [L, 0], [L, yB], [0, yF]]]), Math.min(10, yF / 2), 0);
  const hole = soften(outer.offset(-t, 'Round', 2, 48), 3, 0);
  // wavy web between the bars, the same constant wall as the frame
  const k = Math.max(1, Math.round(L / 75));
  const x0 = L * 0.12;
  const x1 = L - t * 1.5;
  const path: Vec2[] = Array.from({ length: 241 }, (_, i) => {
    const x = x0 + ((x1 - x0) * i) / 240;
    const ph = (2 * Math.PI * k * i) / 240 + Math.PI;
    return [x, t / 2 + (top(x) - 1.5 * t) * (0.5 - 0.5 * Math.cos(ph))] as Vec2;
  });
  let profile = outer.subtract(hole).add(ribbon(M, path, t * 0.8).intersect(outer));
  if (lip > 0) {
    const rl = (lip + t) / 2;
    profile = profile.add(circle(M, rl, [rl, yF + lip - rl]));
  }
  // round the pockets between web and bars into soft lozenges instead of sharp V's
  profile = soften(profile, 0, Math.min(8, yF * 0.35));
  const piece = softPrism(M, profile, W, { rTop: Math.min(2.5, W / 6), chamfer: 0.6 });
  ensureFits(piece, printer, 'Een laptopstandaard');
  const spread = 220;
  const scene: SceneItem[] = [-1, 1].map((side) => ({ kind: 'part', part: 0, matrix: mul(translation(side * spread / 2 - W / 2, -L / 2, 0), mul(rotZ(90), rotX(90))) }));
  return {
    parts: [{ name: 'Laptopstandaard (zijstuk)', solid: piece, quantity: 2, material: 'petg-hf' }],
    scene,
    defaultView: 'assembly',
    info: [{ kind: 'kv', title: 'Maat', rows: [['Hoek', `${num(p, 'laptopAngle').toFixed(0)}°`], ['Hoogte voor / achter', `${(yF + lip).toFixed(0)} / ${yB.toFixed(0)} mm`], ['Zijstuk', `${L.toFixed(0)} × ${W.toFixed(0)} mm`]] }],
    tips: [
      'Print beide zijstukken plat op hun zijkant: het frame, de golf en de parelrand printen zonder support.',
      'Zet de zijstukken onder de linker- en rechterkant van je laptop; de parelrand voorop houdt hem tegen.',
    ],
  };
}

// ---- cable comb ----------------------------------------------------------------

function cableOrganizer(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const cableD = num(p, 'cableD');
  const n = Math.round(num(p, 'cableCount'));
  const gap = num(p, 'cableGap');
  const depth = num(p, 'cableDepth');
  const mount = str(p, 'cableMount');
  const r = cableD / 2 + 0.3;
  // narrower than the cable: it snaps in, and the lip stays printable (≤ 48° overhang)
  const entry = Math.max(1.6, 2 * r * 0.68);
  const pitch = 2 * r + gap;
  const base = 4;
  const vc = base + r;
  const fr = (pitch - entry) / 2;
  const top = vc + r + 1.5 + fr;
  const tab = mount === 'screws' ? 14 : 0;
  const half = (n / 2) * pitch + fr;
  const parts: CrossSection[] = [rect(M, -half - tab, 0, half + tab, vc + (tab ? 0 : 1))];
  for (let k = 0; k <= n; k++) {
    const u = (k - n / 2) * pitch;
    parts.push(rect(M, u - fr, 0, u + fr, top - fr), circle(M, fr, [u, top - fr]));
  }
  const slots = Array.from({ length: n }, (_, k) => {
    const u = (k - (n - 1) / 2) * pitch;
    return M.CrossSection.union([circle(M, r, [u, vc]), rect(M, u - entry / 2, vc, u + entry / 2, top + 5)]);
  });
  const rp = clamp(depth * 0.2, 1.2, 2.5);
  const profile = softenOnBed(M, M.CrossSection.union(parts).subtract(M.CrossSection.union(slots)), rp * 1.15, 1);
  let solid = pillowPrism(M, profile, depth, rp, notOnBed).rotate([90, 0, 0]).translate([0, depth / 2, 0]);
  if (tab) {
    const sink = [-half - tab / 2, half + tab / 2].map((x) => countersunk(M, 4.2, 8.4, vc + 0.2).mirror([0, 0, 1]).translate([x, 0, vc]));
    solid = solid.subtract(M.Manifold.union(sink));
  }
  ensureFits(solid, printer, 'De kabelhouder');
  const mountTip = mount === 'screws'
    ? 'Schroef de houder op of onder je bureau met twee verzonken schroeven door de lipjes aan de zijkant.'
    : mount === 'adhesive'
      ? 'Plak dubbelzijdige tape onder de vlakke bodem; ontvet het oppervlak eerst goed.'
      : 'Zet de houder los op je bureau; de vlakke bodem staat stabiel.';
  return {
    parts: [{ name: 'Golfkabelhouder', solid, material: 'petg-hf' }],
    info: [{ kind: 'kv', title: 'Indeling', rows: [['Sleuven', `${n} × kabel Ø${cableD.toFixed(1)} mm`], ['Klikopening', `${entry.toFixed(1)} mm`], ['Hart-op-hart', `${pitch.toFixed(1)} mm`]] }],
    tips: [
      'Print rechtop op de bodem: de ronde vingers en de klik-sleuven printen zonder support.',
      'Druk een kabel van boven door de smalle opening; hij klikt in de ronde sleuf en blijft liggen.',
      mountTip,
    ],
  };
}

// ---- wall hangers --------------------------------------------------------------

/** Side profile of one hook (x out from the wall, y up), arm on the bed, tip up. */
function hookProfile(M: ManifoldToplevel, look: string, T: number, reach: number, t: number, tipH: number): CrossSection {
  const stub = rect(M, 0, 0, T, t + 4);
  if (look === 'beads') {
    const rb = t / 2;
    const step = rb * 1.4;
    const beads: CrossSection[] = [stub, rect(M, 0, 0, reach - rb, rb), rect(M, 0, 0, reach - rb * 0.2, rb * 0.4)];
    const xEnd = reach - rb;
    const nx = Math.max(1, Math.round((xEnd - (T + rb * 0.4)) / step));
    for (let i = 0; i <= nx; i++) beads.push(circle(M, rb, [xEnd - (i * (xEnd - T - rb * 0.4)) / nx, rb]));
    const ny = Math.max(1, Math.round((tipH - 2 * rb) / step));
    for (let i = 1; i <= ny; i++) beads.push(circle(M, rb, [xEnd, rb + (i * (tipH - 2 * rb)) / ny]));
    return soften(M.CrossSection.union(beads), 0, 0.8);
  }
  const shape = M.CrossSection.union([stub, rect(M, 0, 0, reach, t), rect(M, reach - t, 0, reach, tipH)]);
  return softenOnBed(M, shape, t * 0.48, t * 0.9);
}

function wallHanger(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const style = str(p, 'hangStyle');
  const look = str(p, 'hangLook');
  const n = style === 'rail' ? Math.round(num(p, 'hangCount')) : 1;
  const pitch = num(p, 'hangPitch');
  const reach = num(p, 'hangReach');
  const t = num(p, 'hangThick');
  const wH = num(p, 'hangWidth');
  const tipH = Math.max(num(p, 'hangTip'), t * 1.5);
  const screws = str(p, 'hangMount') === 'screws';
  const T = 7;
  if (n > 1 && pitch < wH + 10) throw new UserError('De haken staan te dicht op elkaar: maak de afstand minstens 10 mm groter dan de haakbreedte.');
  if (reach < T + t * 1.6) throw new UserError('De haak is te kort voor deze dikte: maak hem langer of dunner.');
  const endM = screws ? (n > 1 ? 18 : 4) : 6;
  const L = (n - 1) * pitch + wH + 2 * endM;
  const vFix = t + 10;
  const Hp = Math.max(num(p, 'hangPlateH'), screws ? vFix + 9 : t + 12);

  const rPlate = 2.8;
  const plateCs = softenOnBed(M, rect(M, 0, 0, T, Hp), rPlate * 1.15, 0);
  const pieces = [pillowPrism(M, plateCs, L, rPlate, notOnBedOrWall).rotate([90, 0, 0]).translate([0, L / 2, 0])];
  const hook = pillowPrism(M, hookProfile(M, look, T, reach, t, tipH), wH, Math.min(t * 0.45, wH * 0.45), notOnBedOrWall).rotate([90, 0, 0]);
  for (let i = 0; i < n; i++) pieces.push(hook.translate([0, (i - (n - 1) / 2) * pitch + wH / 2, 0]));
  let solid = M.Manifold.union(pieces);

  if (screws) {
    const ys = n > 1 ? [-L / 2 + endM / 2 + 0.5, L / 2 - endM / 2 - 0.5] : [0];
    const v = n > 1 ? Hp / 2 : vFix;
    const along = (r: number, len: number) => teardrop(M, r, 32).rotate(90).extrude(len).rotate([0, 90, 0]);
    const cuts = ys.flatMap((y) => [along(2.25, T + 2).translate([-1, y, v]), along(4.3, 4).translate([T - 2.4, y, v])]);
    solid = solid.subtract(M.Manifold.union(cuts));
  }
  ensureFits(solid, printer, 'De wandhanger');
  const name = n > 1 ? (look === 'beads' ? 'Parelrek' : 'Buisrek') : look === 'beads' ? 'Parelhaak' : 'Buishaak';
  return {
    parts: [{ name, solid, material: 'petg-hf' }],
    info: [{ kind: 'kv', title: 'Maat', rows: [['Plaat', `${L.toFixed(0)} × ${Hp.toFixed(0)} mm`], ['Haken', `${n} × ${wH.toFixed(0)} mm breed, ${(reach - T).toFixed(0)} mm uit de muur`]] }],
    tips: [
      'Print staand op de onderkant: de armen liggen plat op het bed en de lagen lopen door de hele haak. Geen support nodig.',
      screws ? 'Schroef de plaat met verzonken schroeven (Ø4 mm) en pluggen vast; de schroefkoppen vallen weg in de verzonken gaten.' : 'Plak sterke dubbelzijdige montagetape op de vlakke achterkant; alleen voor lichte spullen zoals sleutels of tassen.',
    ],
  };
}

// ---- shared shell helpers -------------------------------------------------------

/** Relief for an upright wall of height h (rounded rim rTop, bed chamfer c). */
const lookOf = (kind: string, h: number, rTop: number, c: number) => surfaceTexture(kind, c + 0.4, h - rTop - 0.4);
/** Largest outward relief of a texture, to keep loose inserts clear of it. */
const reliefOf = (kind: string) => (kind === 'smooth' ? 0 : kind === 'bulge' ? 5.8 : 2);

/** Keep everything below the plane through (y = -D/2, z = hFront) and (y = D/2, z = hBack). */
function slopeCut(M: ManifoldToplevel, solid: Manifold, D: number, hFront: number, hBack: number): Manifold {
  const a = (Math.atan2(hBack - hFront, D) * 180) / Math.PI;
  const big = 4000;
  const below = M.Manifold.cube([big, big, big]).translate([-big / 2, -big / 2, -big]).rotate([a, 0, 0]).translate([0, 0, (hFront + hBack) / 2]);
  return solid.intersect(below);
}

/** A cup with a rounded rim and a soft floor cove, optionally with a low divider across. */
function looseCup(M: ManifoldToplevel, cs: CrossSection, h: number, wall: number, kind: string, divider = 0): Manifold {
  // big 45° foot chamfer: clears the rounded cove where the host's floor meets its wall
  let cup = softPrism(M, cs, h, { rTop: Math.min(1, wall * 0.4), chamfer: 2.4, texture: lookOf(kind, h, 1, 2.4) });
  const inner = cs.offset(-wall, 'Round', 2, 48);
  cup = cup.subtract(softCavity(M, inner, 2, h, Math.min(1, wall * 0.4), 3));
  if (divider > 0) {
    const b = inner.bounds();
    const wallCs = rect(M, b.min[0] - 1, -wall / 2, b.max[0] + 1, wall / 2).intersect(inner.offset(0.5, 'Round', 2, 48));
    cup = cup.add(softPrism(M, wallCs, divider, { rTop: 0 }));
  }
  return cup;
}

// ---- desk organiser ---------------------------------------------------------------

function deskOutline(M: ManifoldToplevel, shape: string, W: number, D: number): CrossSection {
  const r = Math.min(W, D) * 0.16;
  let cs = roundedRect(M, W, D, r, 32);
  if (shape === 'angled') {
    const c = D * 0.45;
    cs = soften(cs.subtract(csOf(M, [[[W / 2 - c, -D / 2 - 1], [W / 2 + 1, -D / 2 - 1], [W / 2 + 1, -D / 2 + c]]])), r, 0);
  }
  return cs;
}

function deskOrganizer(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const W = num(p, 'deskW');
  const D = num(p, 'deskD');
  const Hf = num(p, 'deskHFront');
  const Hb = num(p, 'deskHBack');
  const wall = num(p, 'deskWall');
  const kind = str(p, 'deskLook');
  const insert = str(p, 'deskInsert');
  const wi = num(p, 'deskInsertW');
  const tiers = clamp(Math.round(num(p, 'deskTiers')), 1, 3);
  const bottom = 2.4;
  if (Hb < Hf) throw new UserError('Maak de achterkant minstens zo hoog als de voorkant.');
  if (insert !== 'none' && wi > W - 2 * wall - 30) throw new UserError('De inzet is te breed voor deze bak: maak hem smaller of de bak breder.');

  const outline = deskOutline(M, str(p, 'deskShape'), W, D);
  const top = Hb + 2;
  let box = softPrism(M, outline, top, { rTop: 1, chamfer: 0.8, texture: lookOf(kind, top, 1, 0.8) });
  const cavity = soften(outline.offset(-wall, 'Round', 2, 48), 3, 0);
  box = box.subtract(softCavity(M, cavity, bottom, top + 1, 0.5, 3));

  // dividers run across the main area, each lower than the rim at its spot: the tiers step up to the back
  const xa = insert === 'none' ? -W / 2 : -W / 2 + wall + wi;
  const rimAt = (y: number) => Hf + ((Hb - Hf) * (y + D / 2)) / D;
  const heights: number[] = [];
  for (let k = 1; k < tiers; k++) {
    const y = -D / 2 + (D * k) / tiers;
    const h = bottom + (rimAt(y) - bottom) * 0.72;
    heights.push(h);
    const cs = rect(M, xa, y - wall / 2, W / 2 + 1, y + wall / 2).intersect(cavity.offset(0.6, 'Round', 2, 48));
    box = box.add(softPrism(M, cs, h, { rTop: wall * 0.35 }));
  }
  box = slopeCut(M, box, D, Hf, Hb);
  ensureFits(box, printer, 'De organiser');

  const parts: BuildOutput['parts'] = [{ name: 'Organiser', solid: box, material: 'pla-matte' }];
  const scene: SceneItem[] = [{ kind: 'part', part: 0, matrix: translation(0, 0, 0) }];
  let insertInfo = 'geen';
  if (insert !== 'none') {
    const clear = 0.6;
    const iw = wi - 2 * clear;
    const innerD = D - 2 * wall - 2 * clear;
    const square = insert === 'square';
    const id = square ? Math.min(iw, innerD) : innerD;
    const rCorner = Math.max(Math.min(W, D) * 0.16 - wall + 1, iw * 0.22);
    const cs = square ? roundedRect(M, iw, id, Math.min(rCorner, iw / 2 - 0.01), 32) : roundedRect(M, iw, id, iw / 2 - 0.01, 32);
    const hi = Hb + 10 - bottom;
    const cup = looseCup(M, cs, hi, 2, 'smooth', square ? 0 : hi * 0.45);
    ensureFits(cup, printer, 'De inzet');
    parts.push({ name: square ? 'Vierkante inzet' : 'Pil-inzet', solid: cup, material: 'pla-matte' });
    const ix = -W / 2 + wall + wi / 2;
    const iy = square ? D / 2 - wall - clear - id / 2 : 0;
    scene.push({ kind: 'part', part: 1, matrix: translation(ix, iy, bottom) });
    insertInfo = `${iw.toFixed(0)} × ${id.toFixed(0)} × ${hi.toFixed(0)} mm, los`;
  }
  return {
    parts,
    scene,
    defaultView: 'assembly',
    info: [{
      kind: 'kv',
      title: 'Indeling',
      rows: [
        ['Buitenmaat', `${W.toFixed(0)} × ${D.toFixed(0)} mm, ${Hf.toFixed(0)} mm voor tot ${Hb.toFixed(0)} mm achter`],
        ['Vakken', tiers > 1 ? `${tiers} trappen, tussenwanden ${heights.map((h) => h.toFixed(0)).join(' en ')} mm hoog` : '1 groot vak'],
        ['Inzet', insertInfo],
      ],
    }],
    tips: [
      'Print de bak en de inzet rechtop op de bodem: de schuine rand en de tussenwanden printen zonder support.',
      'Print de inzet in een tweede kleur voor het studio-loop-effect, bijvoorbeeld geel met blauw.',
    ],
  };
}

// ---- wavy tray --------------------------------------------------------------------

function blobTray(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const n = clamp(Math.round(num(p, 'trayCount')), 2, 3);
  let R1 = num(p, 'trayD1') / 2;
  let R2 = num(p, 'trayD2') / 2;
  const H = num(p, 'trayH');
  // shrink the lobes (keeping their ratio) when the layout would not fit the bed
  const u = usable(printer);
  const span = (a: number, b: number) => (n === 2 ? [2 * a + 2 * b + 3, 2 * Math.max(a, b)] : [2 * (a + b + 3) * Math.cos(Math.PI / 6) + 2 * b, 2 * (a + b + 3) * Math.sin(Math.PI / 6) + 2 * b]);
  const [w0, d0] = span(R1, R2);
  const fit = Math.min(1, (u.x - 2) / w0, (u.y - 2) / d0);
  R1 *= fit;
  R2 *= fit;
  const kind = str(p, 'trayLook');
  const inserts = str(p, 'trayInserts');
  const wall = 2.6;
  const bottom = 2.4;
  const d = R1 + R2 + 3;
  // circles touching side by side; closing the gap gives the soft bean waist
  const lobes: { c: Vec2; r: number }[] = n === 2
    ? [{ c: [-d / 2, R1 - Math.max(R1, R2)], r: R1 }, { c: [d / 2, R2 - Math.max(R1, R2)], r: R2 }]
    : [
        { c: [0, 0], r: R1 },
        { c: [d * Math.cos((5 * Math.PI) / 6), d * Math.sin((5 * Math.PI) / 6)], r: R2 },
        { c: [d * Math.cos(-Math.PI / 6), d * Math.sin(-Math.PI / 6)], r: R2 },
      ];
  const outline = soften(M.CrossSection.union(lobes.map(({ c, r }) => circle(M, r, c))), 0, Math.min(R1, R2) * 0.75);
  let tray = softPrism(M, outline, H, { rTop: 1.2, chamfer: 0.6, texture: lookOf(kind, H, 1.2, 0.6) });
  tray = tray.subtract(softCavity(M, outline.offset(-wall, 'Round', 2, 48), bottom, H, 1.2, 3));
  ensureFits(tray, printer, 'Het dienblad');

  const parts: BuildOutput['parts'] = [{ name: 'Golfdienblad', solid: tray, material: 'pla-matte' }];
  const scene: SceneItem[] = [{ kind: 'part', part: 0, matrix: translation(0, 0, 0) }];
  const rows: [string, string][] = [];
  if (fit < 1) rows.push(['Verkleind', `rondingen Ø${(2 * R1).toFixed(0)} en Ø${(2 * R2).toFixed(0)} mm, zodat het op de plaat past`]);
  if (inserts !== 'none') {
    const cupH = num(p, 'trayCupH');
    lobes.forEach(({ c, r }, i) => {
      const tall = inserts === 'cup' && i === 1;
      const look = tall ? kind : 'smooth';
      const rr = r - wall - 0.6 - (tall ? reliefOf(kind) : 0);
      const h = tall ? cupH : Math.max(8, H - 4 - bottom);
      const solid = looseCup(M, M.CrossSection.circle(rr, 160), h, 2, look);
      ensureFits(solid, printer, tall ? 'De beker' : 'Het schaaltje');
      parts.push({ name: tall ? 'Beker' : `Schaaltje Ø${(2 * rr).toFixed(0)}`, solid, material: 'pla-matte' });
      scene.push({ kind: 'part', part: parts.length - 1, matrix: translation(c[0], c[1], bottom) });
      rows.push([tall ? 'Beker' : `Schaaltje ${i + 1}`, `Ø${(2 * rr).toFixed(0)} × ${h.toFixed(0)} mm`]);
    });
  }
  const [sx, sy] = sizeOf(tray);
  return {
    parts,
    scene,
    defaultView: 'assembly',
    info: [{ kind: 'kv', title: 'Maat', rows: [['Dienblad', `${sx.toFixed(0)} × ${sy.toFixed(0)} × ${H.toFixed(0)} mm`], ...rows] }],
    tips: [
      'Print het dienblad en de schaaltjes plat op de bodem; alles print zonder support.',
      'De schaaltjes liggen los in de ronde vakken: zo heb je vakjes op verschillende hoogtes en kun je ze eruit pakken.',
    ],
  };
}

// ---- wall click mount ("muurklik") -------------------------------------------------

/**
 * Universal wall plate: a tapered, pointed shield with dovetail sides. It is
 * screwed to the wall; a product with a matching channel in its back slides
 * down over it, wedges tight on the taper and cannot be pulled off the wall.
 */
const KLIK = { wb: 34, wt: 22, h: 46, t: 6, e: 2.2, clear: 0.25 };

function klikFront(M: ManifoldToplevel): CrossSection {
  const { wb, wt, h } = KLIK;
  const yr = h - wt / 2;
  const shield = csOf(M, [[[-wb / 2, 0], [wb / 2, 0], [wt / 2, yr], [0, h], [-wt / 2, yr]]]);
  // round bottom corners, but keep the 45° roof pointed: the channel above it then prints without support
  return soften(shield, 3, 0).add(shield.intersect(rect(M, -wb, yr - 3, wb, h + 1)));
}

/** The plate between t0 and t1 (t = distance from the wall), grown by `grow`. */
function klikSolid(M: ManifoldToplevel, grow: number, t0: number, t1: number): Manifold {
  const { t, e } = KLIK;
  const loop = resample(loopsOf(klikFront(M).offset(grow, 'Round', 2, 48)).outers[0], 0.5);
  const d = (z: number) => e * (1 - z / t);
  return loftLoop(M, loop, [{ t: t0, d: d(t0) }, { t: t1, d: d(t1) }]);
}

function klikPlate(M: ManifoldToplevel, screws: number): Manifold {
  let plate = klikSolid(M, 0, 0, KLIK.t);
  const ys = screws === 2 ? [12, 31] : [17];
  for (const y of ys) plate = plate.subtract(countersunk(M, 4.4, 9, KLIK.t + 1).mirror([0, 0, 1]).translate([0, y, KLIK.t]));
  return plate;
}

/**
 * Cutter for the matching channel, in product coordinates: the back face is
 * at y = yBack (facing +y), the plate's bottom sits at z = zm once hung. The
 * channel is open at the bottom so the product slides down over the plate.
 */
function klikChannel(M: ManifoldToplevel, yBack: number, zm: number): Manifold {
  const c = klikSolid(M, KLIK.clear, -1, KLIK.t + 0.35).rotate([90, 0, 0]);
  return M.Manifold.hull([c.translate([0, yBack, zm]), c.translate([0, yBack, -KLIK.h - 2])]);
}

// ---- key tray -----------------------------------------------------------------------

function keyTray(M: ManifoldToplevel, p: Params, printer: PrinterProfile): BuildOutput {
  const W = num(p, 'keyW');
  const D = num(p, 'keyD');
  const Hf = num(p, 'keyHFront');
  const Hb = num(p, 'keyHBack');
  const kind = str(p, 'keyLook');
  const cells = clamp(Math.round(num(p, 'keyCells')), 1, 4);
  const screws = Number(str(p, 'keyScrews'));
  const wall = 2.4;
  const bottom = 2.4;
  const backT = KLIK.t + 0.35 + 2.4;
  if (Hb < KLIK.h + 12) throw new UserError(`Maak de achterkant minstens ${KLIK.h + 12} mm hoog: daar zit de sleuf voor het muurplaatje in.`);
  if (Hb < Hf) throw new UserError('Maak de achterkant minstens zo hoog als de voorkant.');
  if (W < KLIK.wb + 30) throw new UserError('De sleutelbak is te smal voor het muurplaatje.');
  if (D < backT + 20) throw new UserError('De sleutelbak is te ondiep: maak hem minstens ' + Math.ceil(backT + 20) + ' mm diep.');

  // round at the front, almost square at the back so it sits flat against the wall
  const rf = Math.min(D * 0.45, W * 0.3);
  const outline = soften(roundedRect(M, W, D, rf, 32).add(rect(M, -W / 2, 0, W / 2, D / 2)), 4, 0);
  const top = Hb + 2;
  const base = lookOf(kind, top, 1, 0.8);
  // no relief on the back: it has to lie flat against the wall
  const texture = base && { ...base, at: (s: number, P: number, z: number, n: Vec2) => base.at(s, P, z, n) * clamp((0.6 - n[1]) / 0.3, 0, 1) };
  let solid = softPrism(M, outline, top, { rTop: 1, chamfer: 0.8, texture });
  const inner = soften(outline.offset(-wall, 'Round', 2, 48).intersect(rect(M, -W, -D, W, D / 2 - backT)), 3, 0);
  solid = solid.subtract(softCavity(M, inner, bottom, top + 1, 0.5, 4));
  const ib = inner.bounds();
  const span = ib.max[0] - ib.min[0];
  for (let k = 1; k < cells; k++) {
    const x = ib.min[0] + (span * k) / cells;
    const cs = rect(M, x - wall / 2, -D, x + wall / 2, D).intersect(inner.offset(0.6, 'Round', 2, 48));
    solid = solid.add(softPrism(M, cs, Math.max(bottom + 8, Hf * 0.75), { rTop: 0 }));
  }
  solid = slopeCut(M, solid, D, Hf, Hb);
  const zm = Hb - 6 - KLIK.h;
  solid = solid.subtract(klikChannel(M, D / 2, zm));
  ensureFits(solid, printer, 'De sleutelbak');

  const plate = klikPlate(M, screws);
  return {
    parts: [
      { name: 'Sleutelbak', solid, material: 'pla-matte' },
      { name: 'Muurklik-plaatje', solid: plate, material: 'petg-hf' },
    ],
    scene: [
      { kind: 'part', part: 0, matrix: translation(0, 0, 0) },
      { kind: 'part', part: 1, matrix: mul(translation(0, D / 2, zm), rotX(90)) },
      { kind: 'box', size: [W + 120, 6, Hb + 90], position: [-(W + 120) / 2, D / 2, -45], color: '#e8e4dc', material: 'ghost', label: 'Je muur' },
    ],
    defaultView: 'assembly',
    info: [
      {
        kind: 'kv',
        title: 'Muurklik',
        rows: [
          ['Plaatje', `${KLIK.wb} × ${KLIK.h} × ${KLIK.t} mm, taps met zwaluwstaart`],
          ['Schroeven', `${screws}× verzonken Ø4 mm (30–40 mm) met universele plug Ø6 mm`],
          ['Ophanghoogte', `bovenkant bak ${(Hb - zm).toFixed(0)} mm boven de onderkant van het plaatje`],
        ],
      },
      { kind: 'kv', title: 'Maat', rows: [['Bak', `${W.toFixed(0)} × ${D.toFixed(0)} mm, ${Hf.toFixed(0)} mm voor tot ${Hb.toFixed(0)} mm achter`], ['Vakken', `${cells}`]] },
    ],
    tips: [
      'Schroef het plaatje met de punt naar boven tegen de muur; gebruik een waterpas, dan hangt de bak recht.',
      'Schuif de bak van bovenaf over het plaatje: de tapse zijkanten klemmen hem vast en de zwaluwstaart houdt hem tegen de muur. Optillen = losmaken.',
      'Print de bak rechtop en het plaatje plat met de muurkant op het bed: geen support nodig. Print het plaatje met 100% vulling.',
      'Elk product met een muurklik-sleuf past op hetzelfde plaatje: hang meerdere plaatjes op en wissel je bakjes.',
    ],
  };
}

// ---- print settings ------------------------------------------------------------

interface PrintProfile {
  material: string;
  layer: string;
  walls: number;
  topBottom: string;
  infill: string;
  seam: string;
  extra: string;
}

const PRINT_PROFILES: Record<string, PrintProfile> = {
  soap: {
    material: 'PETG HF (waterbestendig)',
    layer: '0,16 mm (gladde ronde rand)',
    walls: 3,
    topBottom: '5 onder / 4 boven',
    infill: '15% gyroid',
    seam: 'Uitgelijnd, achterkant',
    extra: 'Ironing uit: de golfribbels zijn rond en hebben geen vlakke bovenkant',
  },
  pen: {
    material: 'PLA Matte (mooiste oppervlak) of PETG HF',
    layer: '0,16 mm',
    walls: 3,
    topBottom: '5 onder',
    infill: '10% gyroid',
    seam: 'Uitgelijnd, achterkant (valt weg in een groef)',
    extra: 'Wandvolgorde buiten/binnen (outer/inner) voor scherpe ribbels',
  },
  monitor: {
    material: 'PETG HF',
    layer: '0,20 mm',
    walls: 5,
    topBottom: '5 / 5',
    infill: '40% gyroid',
    seam: 'Uitgelijnd, achterkant',
    extra: 'Print de poten tegelijk op één plaat: dan zijn ze precies even hoog en ligt de plank vlak',
  },
  cable: {
    material: 'PETG HF (veert mee) of TPU 95A HF',
    layer: '0,16 mm',
    walls: 4,
    topBottom: '4 / 4',
    infill: '25% gyroid',
    seam: 'Uitgelijnd, achterkant',
    extra: '4 wanden maken de vingers massief: ze veren mee zonder te breken',
  },
  laptop: {
    material: 'PETG HF (stijf en taai) of PLA Matte',
    layer: '0,20 mm',
    walls: 4,
    topBottom: '4 / 4',
    infill: '20% gyroid',
    seam: 'Uitgelijnd, achterkant',
    extra: 'Wandvolgorde buiten/binnen (outer/inner): de lange ronde bochten worden dan het gladst',
  },
  desk: {
    material: 'PLA Matte (bak en inzet in twee kleuren)',
    layer: '0,16 mm',
    walls: 3,
    topBottom: '5 onder',
    infill: '10% gyroid',
    seam: 'Uitgelijnd, achterkant (valt weg in een groef)',
    extra: 'Wandvolgorde buiten/binnen (outer/inner) voor een strak reliëf',
  },
  tray: {
    material: 'PLA Matte',
    layer: '0,16 mm (gladde horizontale ribbels)',
    walls: 3,
    topBottom: '5 onder',
    infill: '10% gyroid',
    seam: 'Uitgelijnd, achterkant',
    extra: 'Wandvolgorde buiten/binnen (outer/inner); print de schaaltjes in een contrastkleur',
  },
  keys: {
    material: 'PLA Matte (bak) en PETG HF (muurplaatje)',
    layer: '0,16 mm',
    walls: 4,
    topBottom: '5 / 5',
    infill: '15% gyroid (plaatje: 100%)',
    seam: 'Uitgelijnd, achterkant (tegen de muur)',
    extra: '4 wanden rond de sleuf houden de klemverbinding stevig',
  },
  wallhook: {
    material: 'PETG HF',
    layer: '0,20 mm',
    walls: 5,
    topBottom: '5 / 5',
    infill: '50% gyroid',
    seam: 'Uitgelijnd, achterkant (tegen de muur)',
    extra: 'Printstand niet veranderen: de lagen lopen dan door de arm heen',
  },
};

function printSettings(type: string, printer: PrinterProfile): { info: InfoBlock; tips: string[] } {
  const pr = PRINT_PROFILES[type];
  const rows: [string, string][] = [
    ['Printer', printer.name],
    ['Filament', pr.material],
    ['Laaghoogte', pr.layer],
    ['Wandlussen (wall loops)', `${pr.walls}`],
    ['Boven-/onderlagen', pr.topBottom],
    ['Vulling (sparse infill)', pr.infill],
    ['Naad (seam)', pr.seam],
    ['Support', 'Uit: het ontwerp print zonder support'],
    ['Tip', pr.extra],
  ];
  const tips: string[] = [];
  if (printer.enclosed) {
    tips.push(`De ${printer.name} is gesloten: zet bij PLA de deur en het deksel open (of kies de PLA-instelling met open deur), anders wordt het te warm en krijg je hittekruip. PETG kan met de deur dicht.`);
  }
  if (printer.nozzles === 2) {
    tips.push('Voor een print in één kleur: kies het profiel met 1 nozzle, dan heb je het volledige bed en geen spoelafval.');
  }
  return { info: { kind: 'kv', title: `Printinstellingen (${printer.name})`, rows }, tips };
}

function build(p: Params, ctx: Parameters<ToolDef['build']>[1]): BuildOutput {
  const type = str(p, 'type');
  const out = buildProduct(p, ctx);
  if (!PRINT_PROFILES[type]) return out;
  const settings = printSettings(type, ctx.printer);
  return { ...out, info: [...(out.info ?? []), settings.info], tips: [...(out.tips ?? []), ...settings.tips] };
}

function buildProduct(p: Params, { M, printer }: Parameters<ToolDef['build']>[1]): BuildOutput {
  switch (str(p, 'type')) {
    case 'soap':
      return soapDish(M, p, printer);
    case 'pen':
      return penOrganizer(M, p, printer);
    case 'monitor':
      return monitorRiser(M, p, printer);
    case 'cable':
      return cableOrganizer(M, p, printer);
    case 'laptop':
      return str(p, 'laptopStyle') === 'stand' ? laptopStand(M, p, printer) : laptopDock(M, p, printer);
    case 'wallhook':
      return wallHanger(M, p, printer);
    case 'desk':
      return deskOrganizer(M, p, printer);
    case 'tray':
      return blobTray(M, p, printer);
    case 'keys':
      return keyTray(M, p, printer);
    default:
      throw new UserError('Kies een type opberger.');
  }
}

export const organizersTool: ToolDef = {
  id: 'opbergen',
  name: 'Opbergen & wonen',
  short: 'Opbergen',
  icon: 'M4 5h16v14H4zM8 5v4m4-4v4m4-4v4M7 13h10',
  description: 'Zachte, ronde woonaccessoires: een golfzeepschaal, golvende pennenbak (ook als beker, plus- of achtvorm), schermverhoger met boog- of meanderpoten, meander-laptophouder, bureau-organiser met trappen, golvend dienblad met schaaltjes, sleutelbak met muurklik, klik-kabelhouder en buis- of parelhaken. Kies je textuur: ribbels, ringen, bubbels, twist, bollen of pillen.',
  params: [
    { type: 'group', label: 'Type' },
    {
      type: 'select',
      key: 'type',
      label: 'Wat wil je maken?',
      default: 'soap',
      options: [
        { value: 'soap', label: 'Golfzeepschaal' },
        { value: 'pen', label: 'Golvende pennenbak' },
        { value: 'monitor', label: 'Schermverhoger met boogpoten' },
        { value: 'laptop', label: 'Laptophouder' },
        { value: 'cable', label: 'Klik-kabelhouder' },
        { value: 'wallhook', label: 'Buis- of parelhaak voor de muur' },
        { value: 'desk', label: 'Bureau-organiser met trappen' },
        { value: 'tray', label: 'Golvend dienblad met schaaltjes' },
        { value: 'keys', label: 'Sleutelbak met muurklik' },
      ],
    },

    { type: 'group', label: 'Zeepschaal', show: is('soap') },
    {
      type: 'select',
      key: 'soapShape',
      label: 'Vorm',
      default: 'pill',
      options: [
        { value: 'pill', label: 'Pil (ronde uiteinden)' },
        { value: 'wave', label: 'Golvende rand' },
        { value: 'rounded', label: 'Zachte rechthoek' },
      ],
      show: is('soap'),
    },
    { type: 'number', key: 'soapW', label: 'Breedte', min: 60, max: 300, step: 1, unit: 'mm', default: 120, show: is('soap') },
    { type: 'number', key: 'soapD', label: 'Diepte', min: 45, max: 220, step: 1, unit: 'mm', default: 78, show: is('soap') },
    { type: 'number', key: 'soapH', label: 'Hoogte rand', min: 12, max: 45, step: 1, unit: 'mm', default: 20, show: is('soap') },
    { type: 'number', key: 'soapRibs', label: 'Aantal golfribbels', min: 3, max: 18, step: 1, default: 7, show: is('soap') },
    {
      type: 'select',
      key: 'soapTexture',
      label: 'Buitenkant',
      default: 'flutes',
      options: [
        { value: 'flutes', label: 'Fijne ribbels' },
        { value: 'smooth', label: 'Glad' },
      ],
      show: is('soap'),
    },
    {
      type: 'select',
      key: 'soapDrain',
      label: 'Afwatering',
      default: 'holes',
      options: [
        { value: 'holes', label: 'Gaatjes tussen de ribbels' },
        { value: 'none', label: 'Dichte bodem' },
      ],
      show: is('soap'),
    },

    { type: 'group', label: 'Pennenbak', show: is('pen') },
    {
      type: 'select',
      key: 'penLayout',
      label: 'Opstelling',
      default: 'zigzag',
      options: [
        { value: 'zigzag', label: 'Golvende slinger' },
        { value: 'row', label: 'Rij' },
        { value: 'cluster', label: 'Bloem (in een kring)' },
        { value: 'cup', label: 'Ronde beker met vakken' },
        { value: 'plus', label: 'Plusvorm op ronde voet' },
      ],
      show: is('pen'),
    },
    { type: 'number', key: 'penCells', label: 'Aantal vakken', min: 1, max: 7, step: 1, default: 3, show: (p) => is('pen')(p) && str(p, 'penLayout') !== 'plus' },
    { type: 'number', key: 'penCellD', label: 'Diameter per vak', min: 30, max: 80, step: 1, unit: 'mm', default: 46, show: (p) => is('pen')(p) && !penRound(p) },
    { type: 'number', key: 'penCupD', label: 'Diameter', min: 50, max: 140, step: 1, unit: 'mm', default: 80, show: (p) => is('pen')(p) && penRound(p) },
    { type: 'number', key: 'penH', label: 'Hoogte', min: 40, max: 180, step: 1, unit: 'mm', default: 105, show: is('pen') },
    { type: 'number', key: 'penWall', label: 'Wanddikte', min: 1.6, max: 4, step: 0.2, unit: 'mm', default: 2.4, show: is('pen') },
    {
      type: 'select',
      key: 'penCavity',
      label: 'Binnenkant',
      default: 'cells',
      options: [
        { value: 'cells', label: 'Losse ronde vakken' },
        { value: 'open', label: 'Eén doorlopend golfvak' },
      ],
      show: (p) => is('pen')(p) && !penRound(p),
    },
    {
      type: 'select',
      key: 'penLook',
      label: 'Buitenkant',
      default: 'flutes',
      options: LOOKS,
      show: is('pen'),
    },

    { type: 'group', label: 'Schermverhoger', show: is('monitor') },
    {
      type: 'select',
      key: 'monitorStyle',
      label: 'Vorm poot',
      default: 'arch',
      options: [
        { value: 'arch', label: 'Geribbelde boog (met kabeltunnel)' },
        { value: 'meander', label: 'Meanderwand' },
      ],
      show: is('monitor'),
    },
    { type: 'number', key: 'monitorBoardW', label: 'Breedte plank', min: 250, max: 1200, step: 1, unit: 'mm', default: 600, show: is('monitor') },
    { type: 'number', key: 'monitorBoardD', label: 'Diepte plank', min: 120, max: 500, step: 1, unit: 'mm', default: 240, show: is('monitor') },
    { type: 'number', key: 'monitorBoardT', label: 'Dikte plank', min: 10, max: 40, step: 1, unit: 'mm', default: 18, show: is('monitor') },
    { type: 'number', key: 'monitorH', label: 'Hoogte onder plank', min: 50, max: 200, step: 1, unit: 'mm', default: 85, show: is('monitor') },
    {
      type: 'select',
      key: 'monitorFeet',
      label: 'Aantal poten',
      default: '2',
      options: [
        { value: '2', label: '2 lange bogen (aanbevolen)' },
        { value: '4', label: '4 korte bogen' },
      ],
      show: (p) => is('monitor')(p) && str(p, 'monitorStyle') !== 'meander',
    },
    { type: 'number', key: 'monitorFootW', label: 'Breedte poot', min: 40, max: 160, step: 1, unit: 'mm', default: 76, show: is('monitor') },
    { type: 'number', key: 'monitorFootD', label: 'Diepte poot', min: 30, max: 250, step: 1, unit: 'mm', default: 160, show: is('monitor') },
    { type: 'number', key: 'monitorInset', label: 'Randafstand poten', min: 0, max: 100, step: 1, unit: 'mm', default: 30, show: is('monitor') },
    {
      type: 'select',
      key: 'monitorScrew',
      label: 'Schroefmaat',
      default: 'M4',
      options: [
        { value: 'M3', label: 'M3 / 3 mm' },
        { value: 'M4', label: 'M4 / 4 mm' },
        { value: 'M5', label: 'M5 / 5 mm' },
      ],
      show: is('monitor'),
    },

    { type: 'group', label: 'Laptophouder', show: is('laptop') },
    {
      type: 'select',
      key: 'laptopStyle',
      label: 'Model',
      default: 'dock',
      options: [
        { value: 'dock', label: 'Rechtop dock (dichte laptop)' },
        { value: 'stand', label: 'Schuine standaard (open laptop)' },
      ],
      show: is('laptop'),
    },
    { type: 'number', key: 'laptopSlots', label: 'Aantal sleuven', min: 1, max: 4, step: 1, default: 2, show: laptop('dock') },
    { type: 'number', key: 'laptopSlotW', label: 'Sleufbreedte (dikte laptop + speling)', min: 8, max: 40, step: 0.5, unit: 'mm', default: 22, show: laptop('dock') },
    { type: 'number', key: 'laptopH', label: 'Hoogte', min: 50, max: 160, step: 1, unit: 'mm', default: 95, show: laptop('dock') },
    { type: 'number', key: 'laptopD', label: 'Diepte', min: 40, max: 200, step: 1, unit: 'mm', default: 90, show: laptop('dock') },
    { type: 'number', key: 'laptopPostW', label: 'Breedte bochten', min: 16, max: 50, step: 1, unit: 'mm', default: 26, show: laptop('dock') },
    { type: 'number', key: 'laptopAngle', label: 'Hoek', min: 5, max: 25, step: 1, unit: '°', default: 14, show: laptop('stand') },
    { type: 'number', key: 'laptopLen', label: 'Lengte zijstuk', min: 120, max: 250, step: 1, unit: 'mm', default: 220, show: laptop('stand') },
    { type: 'number', key: 'laptopFront', label: 'Hoogte voorkant', min: 14, max: 50, step: 1, unit: 'mm', default: 20, show: laptop('stand') },
    { type: 'number', key: 'laptopStandW', label: 'Breedte zijstuk', min: 12, max: 50, step: 1, unit: 'mm', default: 22, show: laptop('stand') },
    { type: 'number', key: 'laptopLip', label: 'Hoogte parelrand', min: 0, max: 16, step: 1, unit: 'mm', default: 8, show: laptop('stand') },
    { type: 'number', key: 'laptopWall', label: 'Wanddikte', min: 3, max: 7, step: 0.5, unit: 'mm', default: 4.5, show: is('laptop') },

    { type: 'group', label: 'Kabelhouder', show: is('cable') },
    { type: 'number', key: 'cableD', label: 'Kabeldiameter', min: 2, max: 14, step: 0.5, unit: 'mm', default: 5.5, show: is('cable') },
    { type: 'number', key: 'cableCount', label: 'Aantal kabels', min: 1, max: 12, step: 1, default: 5, show: is('cable') },
    { type: 'number', key: 'cableGap', label: 'Breedte vingers', min: 4, max: 20, step: 0.5, unit: 'mm', default: 7, show: is('cable') },
    { type: 'number', key: 'cableDepth', label: 'Diepte', min: 8, max: 40, step: 1, unit: 'mm', default: 16, show: is('cable') },
    {
      type: 'select',
      key: 'cableMount',
      label: 'Bevestiging',
      default: 'desk',
      options: [
        { value: 'desk', label: 'Los op bureau' },
        { value: 'adhesive', label: 'Dubbelzijdige tape' },
        { value: 'screws', label: 'Twee schroeven' },
      ],
      show: is('cable'),
    },

    { type: 'group', label: 'Wandhanger', show: is('wallhook') },
    {
      type: 'select',
      key: 'hangStyle',
      label: 'Model',
      default: 'rail',
      options: [
        { value: 'single', label: 'Enkele haak' },
        { value: 'rail', label: 'Rek met meerdere haken' },
      ],
      show: is('wallhook'),
    },
    {
      type: 'select',
      key: 'hangLook',
      label: 'Uitstraling',
      default: 'tube',
      options: [
        { value: 'tube', label: 'Dikke buis' },
        { value: 'beads', label: 'Parels' },
      ],
      show: is('wallhook'),
    },
    { type: 'number', key: 'hangCount', label: 'Aantal haken', min: 2, max: 8, step: 1, default: 4, show: (p) => is('wallhook')(p) && str(p, 'hangStyle') === 'rail' },
    { type: 'number', key: 'hangPitch', label: 'Afstand tussen haken', min: 24, max: 120, step: 1, unit: 'mm', default: 56, show: (p) => is('wallhook')(p) && str(p, 'hangStyle') === 'rail' },
    { type: 'number', key: 'hangReach', label: 'Lengte arm', min: 25, max: 100, step: 1, unit: 'mm', default: 52, show: is('wallhook') },
    { type: 'number', key: 'hangTip', label: 'Hoogte punt', min: 15, max: 70, step: 1, unit: 'mm', default: 32, show: is('wallhook') },
    { type: 'number', key: 'hangThick', label: 'Dikte buis', min: 8, max: 20, step: 0.5, unit: 'mm', default: 13, show: is('wallhook') },
    { type: 'number', key: 'hangWidth', label: 'Breedte haak', min: 10, max: 40, step: 1, unit: 'mm', default: 18, show: is('wallhook') },
    { type: 'number', key: 'hangPlateH', label: 'Hoogte plaat', min: 20, max: 90, step: 1, unit: 'mm', default: 42, show: is('wallhook') },
    {
      type: 'select',
      key: 'hangMount',
      label: 'Bevestiging',
      default: 'screws',
      options: [
        { value: 'screws', label: 'Schroeven (verzonken)' },
        { value: 'adhesive', label: 'Montagetape' },
      ],
      show: is('wallhook'),
    },

    { type: 'group', label: 'Bureau-organiser', show: is('desk') },
    {
      type: 'select',
      key: 'deskShape',
      label: 'Vorm',
      default: 'round',
      options: [
        { value: 'round', label: 'Zachte rechthoek' },
        { value: 'angled', label: 'Met schuine hoek' },
      ],
      show: is('desk'),
    },
    { type: 'number', key: 'deskW', label: 'Breedte', min: 100, max: 300, step: 1, unit: 'mm', default: 190, show: is('desk') },
    { type: 'number', key: 'deskD', label: 'Diepte', min: 70, max: 220, step: 1, unit: 'mm', default: 120, show: is('desk') },
    { type: 'number', key: 'deskHFront', label: 'Hoogte voorkant', min: 25, max: 150, step: 1, unit: 'mm', default: 55, show: is('desk') },
    { type: 'number', key: 'deskHBack', label: 'Hoogte achterkant', min: 25, max: 200, step: 1, unit: 'mm', default: 95, show: is('desk') },
    { type: 'number', key: 'deskTiers', label: 'Trappen (vakken van voor naar achter)', min: 1, max: 3, step: 1, default: 2, show: is('desk') },
    {
      type: 'select',
      key: 'deskInsert',
      label: 'Losse inzet',
      default: 'pill',
      options: [
        { value: 'pill', label: 'Pil met tussenwandje' },
        { value: 'square', label: 'Vierkant bakje' },
        { value: 'none', label: 'Geen' },
      ],
      show: is('desk'),
    },
    { type: 'number', key: 'deskInsertW', label: 'Breedte inzet', min: 30, max: 140, step: 1, unit: 'mm', default: 58, show: (p) => is('desk')(p) && str(p, 'deskInsert') !== 'none' },
    { type: 'number', key: 'deskWall', label: 'Wanddikte', min: 1.6, max: 4, step: 0.2, unit: 'mm', default: 2.4, show: is('desk') },
    { type: 'select', key: 'deskLook', label: 'Buitenkant', default: 'flutes', options: LOOKS, show: is('desk') },

    { type: 'group', label: 'Dienblad', show: is('tray') },
    { type: 'number', key: 'trayCount', label: 'Aantal rondingen', min: 2, max: 3, step: 1, default: 2, show: is('tray') },
    { type: 'number', key: 'trayD1', label: 'Grote ronding', min: 60, max: 200, step: 1, unit: 'mm', default: 130, show: is('tray') },
    { type: 'number', key: 'trayD2', label: 'Kleine ronding', min: 40, max: 160, step: 1, unit: 'mm', default: 80, show: is('tray') },
    { type: 'number', key: 'trayH', label: 'Hoogte rand', min: 12, max: 60, step: 1, unit: 'mm', default: 24, show: is('tray') },
    {
      type: 'select',
      key: 'trayInserts',
      label: 'Losse inzetten',
      default: 'dishes',
      options: [
        { value: 'dishes', label: 'Een schaaltje in elke ronding' },
        { value: 'cup', label: 'Schaaltjes plus een hoge beker' },
        { value: 'none', label: 'Geen' },
      ],
      show: is('tray'),
    },
    { type: 'number', key: 'trayCupH', label: 'Hoogte beker', min: 40, max: 180, step: 1, unit: 'mm', default: 100, show: (p) => is('tray')(p) && str(p, 'trayInserts') === 'cup' },
    { type: 'select', key: 'trayLook', label: 'Buitenkant', default: 'rings', options: LOOKS, show: is('tray') },

    { type: 'group', label: 'Sleutelbak', show: is('keys') },
    { type: 'number', key: 'keyW', label: 'Breedte', min: 80, max: 260, step: 1, unit: 'mm', default: 150, show: is('keys') },
    { type: 'number', key: 'keyD', label: 'Diepte', min: 40, max: 140, step: 1, unit: 'mm', default: 70, show: is('keys') },
    { type: 'number', key: 'keyHFront', label: 'Hoogte voorkant', min: 20, max: 150, step: 1, unit: 'mm', default: 42, show: is('keys') },
    { type: 'number', key: 'keyHBack', label: 'Hoogte achterkant', min: 58, max: 200, step: 1, unit: 'mm', default: 85, show: is('keys') },
    { type: 'number', key: 'keyCells', label: 'Vakken', min: 1, max: 4, step: 1, default: 2, show: is('keys') },
    {
      type: 'select',
      key: 'keyScrews',
      label: 'Muurplaatje',
      default: '2',
      options: [
        { value: '2', label: '2 schroeven (draait niet)' },
        { value: '1', label: '1 schroef' },
      ],
      show: is('keys'),
    },
    { type: 'select', key: 'keyLook', label: 'Buitenkant', default: 'flutes', options: LOOKS, show: is('keys') },
  ],
  presets: [
    { name: 'Golfzeepschaal (pil)', values: { type: 'soap', soapShape: 'pill', soapW: 120, soapD: 78, soapH: 20, soapRibs: 7, soapTexture: 'flutes' } },
    { name: 'Bloem-zeepschaal', values: { type: 'soap', soapShape: 'wave', soapW: 110, soapD: 90, soapH: 18, soapRibs: 6, soapTexture: 'smooth' } },
    { name: 'Golvende pennenbak', values: { type: 'pen', penLayout: 'zigzag', penCells: 3, penCellD: 46, penH: 105, penLook: 'flutes', penCavity: 'cells' } },
    { name: 'S-pennenbak (één vak)', values: { type: 'pen', penLayout: 'zigzag', penCells: 2, penCellD: 56, penH: 95, penLook: 'smooth', penCavity: 'open' } },
    { name: 'Bloem-pennenbak', values: { type: 'pen', penLayout: 'cluster', penCells: 5, penCellD: 40, penH: 100, penLook: 'flutes', penCavity: 'cells' } },
    { name: 'Schermverhoger met twee bogen', values: { type: 'monitor', monitorBoardW: 600, monitorBoardD: 240, monitorH: 85, monitorFeet: '2', monitorFootW: 76, monitorFootD: 160 } },
    { name: 'Acht-pot (twee ronde vakken)', values: { type: 'pen', penLayout: 'row', penCells: 2, penCellD: 70, penH: 110, penWall: 2, penLook: 'smooth', penCavity: 'open' } },
    { name: 'Beker met drie vakken', values: { type: 'pen', penLayout: 'cup', penCells: 3, penCupD: 80, penH: 100, penWall: 2.4, penLook: 'smooth' } },
    { name: 'Pluspot', values: { type: 'pen', penLayout: 'plus', penCupD: 80, penH: 95, penWall: 2.4, penLook: 'smooth' } },
    { name: 'Schermverhoger met meanderpoten', values: { type: 'monitor', monitorStyle: 'meander', monitorBoardW: 600, monitorBoardD: 240, monitorH: 85, monitorFootW: 70, monitorFootD: 200 } },
    { name: 'Laptopdock voor twee', values: { type: 'laptop', laptopStyle: 'dock', laptopSlots: 2, laptopSlotW: 22, laptopH: 95, laptopD: 90 } },
    { name: 'Laptopstandaard', values: { type: 'laptop', laptopStyle: 'stand', laptopAngle: 14, laptopLen: 220, laptopFront: 20, laptopLip: 8 } },
    { name: 'Klik-kabelhouder voor vijf kabels', values: { type: 'cable', cableD: 5.5, cableCount: 5, cableGap: 7, cableDepth: 16, cableMount: 'adhesive' } },
    { name: 'Buis-kapstok', values: { type: 'wallhook', hangStyle: 'rail', hangLook: 'tube', hangCount: 4, hangPitch: 56, hangReach: 52, hangThick: 13 } },
    { name: 'Bureau-organiser met pil-inzet', values: { type: 'desk', deskShape: 'round', deskW: 190, deskD: 120, deskHFront: 55, deskHBack: 95, deskTiers: 2, deskInsert: 'pill', deskInsertW: 58, deskLook: 'flutes' } },
    { name: 'Organiser met schuine hoek', values: { type: 'desk', deskShape: 'angled', deskW: 170, deskD: 130, deskHFront: 45, deskHBack: 70, deskTiers: 1, deskInsert: 'square', deskInsertW: 80, deskLook: 'flutes' } },
    { name: 'Boondienblad met schaaltjes', values: { type: 'tray', trayCount: 2, trayD1: 130, trayD2: 80, trayH: 24, trayInserts: 'dishes', trayLook: 'rings' } },
    { name: 'S-dienblad met beker', values: { type: 'tray', trayCount: 3, trayD1: 110, trayD2: 70, trayH: 22, trayInserts: 'cup', trayCupH: 100, trayLook: 'rings' } },
    { name: 'Sleutelbak met muurklik', values: { type: 'keys', keyW: 150, keyD: 70, keyHFront: 42, keyHBack: 85, keyCells: 2, keyScrews: '2', keyLook: 'flutes' } },
    { name: 'Bobbelbeker', values: { type: 'pen', penLayout: 'cup', penCells: 1, penCupD: 80, penH: 100, penWall: 2.4, penLook: 'bubbles' } },
    { name: 'Gedraaide beker', values: { type: 'pen', penLayout: 'cup', penCells: 2, penCupD: 80, penH: 110, penWall: 2.4, penLook: 'twist' } },
    { name: 'Bollenpot', values: { type: 'pen', penLayout: 'cup', penCells: 1, penCupD: 85, penH: 120, penWall: 2.4, penLook: 'bulge' } },
    { name: 'Pillenpot met knoppen', values: { type: 'pen', penLayout: 'cup', penCells: 1, penCupD: 90, penH: 110, penWall: 2.4, penLook: 'pills' } },
    { name: 'Parelhaak', values: { type: 'wallhook', hangStyle: 'single', hangLook: 'beads', hangReach: 48, hangTip: 34, hangThick: 12, hangWidth: 16 } },
  ],
  build,
};
