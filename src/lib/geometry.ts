import { applyToPoint, applyToVector, invert, multiply, type Matrix, type Point } from '../pdf/matrix';

/** pdf.js renders at this many CSS pixels per PDF point at 100% zoom. */
export const CSS_PER_POINT = 96 / 72;

export interface PageInfo {
  /** Crop box in user space: [x1, y1, x2, y2]. */
  view: [number, number, number, number];
  rotation: number;
}

export interface Viewport {
  transform: Matrix;
  width: number;
  height: number;
  scale: number;
}

/** Same transform as pdf.js's PageViewport (user space → CSS pixels, y down). */
export function makeViewport(page: PageInfo, scale: number): Viewport {
  const [x1, y1, x2, y2] = page.view;
  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2;
  let rotation = page.rotation % 360;
  if (rotation < 0) rotation += 360;
  let a = 1;
  let b = 0;
  let c = 0;
  let d = -1;
  if (rotation === 90) [a, b, c, d] = [0, 1, 1, 0];
  else if (rotation === 180) [a, b, c, d] = [-1, 0, 0, 1];
  else if (rotation === 270) [a, b, c, d] = [0, -1, -1, 0];

  let offsetX: number;
  let offsetY: number;
  let width: number;
  let height: number;
  if (a === 0) {
    offsetX = Math.abs(centerY - y1) * scale;
    offsetY = Math.abs(centerX - x1) * scale;
    width = (y2 - y1) * scale;
    height = (x2 - x1) * scale;
  } else {
    offsetX = Math.abs(centerX - x1) * scale;
    offsetY = Math.abs(centerY - y1) * scale;
    width = (x2 - x1) * scale;
    height = (y2 - y1) * scale;
  }
  return {
    transform: [
      a * scale,
      b * scale,
      c * scale,
      d * scale,
      offsetX - a * scale * centerX - c * scale * centerY,
      offsetY - b * scale * centerX - d * scale * centerY,
    ],
    width,
    height,
    scale,
  };
}

export function toCss(vp: Viewport, x: number, y: number): Point {
  return applyToPoint(vp.transform, x, y);
}

export function toUser(vp: Viewport, X: number, Y: number): Point {
  return applyToPoint(invert(vp.transform), X, Y);
}

/** Converts a CSS-pixel displacement into a user-space displacement. */
export function deltaToUser(vp: Viewport, dX: number, dY: number): Point {
  const [a, b, c, d] = vp.transform;
  return applyToVector(invert([a, b, c, d, 0, 0]), dX, dY);
}

/** Screen angle (radians, clockwise) of a user-space direction given in degrees. */
export function cssAngle(vp: Viewport, userDegrees: number): number {
  const r = (userDegrees * Math.PI) / 180;
  const [dx, dy] = applyToVector(vp.transform, Math.cos(r), Math.sin(r));
  return Math.atan2(dy, dx);
}

/** User-space angle (degrees) of text that reads left-to-right on screen. */
export function uprightUserAngle(vp: Viewport): number {
  const [ux, uy] = deltaToUser(vp, 1, 0);
  const deg = (Math.atan2(uy, ux) * 180) / Math.PI;
  return Math.round(deg * 1000) / 1000;
}

/** pdf.js text item transform → CSS placement of its box. */
export function itemBox(vp: Viewport, transform: number[], width: number) {
  const m = multiply(transform as Matrix, vp.transform);
  const height = Math.hypot(m[2], m[3]);
  return {
    left: m[4],
    top: m[5],
    angle: Math.atan2(m[1], m[0]),
    width: width * vp.scale,
    height,
  };
}
