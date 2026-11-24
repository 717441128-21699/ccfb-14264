/**
 * 图像编解码：HTMLImageElement/ImageData ↔ FloatImage，降采样与画布工具。
 */
import type { FloatImage } from './types';

export function imageDataToFloat(img: ImageData): FloatImage {
  const { width, height, data } = img;
  const out = new Float32Array(width * height * 3);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p * 3] = data[i] / 255;
    out[p * 3 + 1] = data[i + 1] / 255;
    out[p * 3 + 2] = data[i + 2] / 255;
  }
  return { width, height, data: out };
}

export function floatToImageData(img: FloatImage, gain = 1): ImageData {
  const out = new ImageData(img.width, img.height);
  for (let p = 0, i = 0; p < img.width * img.height; p++, i += 3) {
    out.data[p * 4] = clamp255(img.data[i] * gain);
    out.data[p * 4 + 1] = clamp255(img.data[i + 1] * gain);
    out.data[p * 4 + 2] = clamp255(img.data[i + 2] * gain);
    out.data[p * 4 + 3] = 255;
  }
  return out;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255);
}

export function maskToImageData(mask: Float32Array, w: number, h: number, rgb: [number, number, number]): ImageData {
  const out = new ImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    const m = mask[p];
    out.data[p * 4] = Math.round(rgb[0] * m * 255);
    out.data[p * 4 + 1] = Math.round(rgb[1] * m * 255);
    out.data[p * 4 + 2] = Math.round(rgb[2] * m * 255);
    out.data[p * 4 + 3] = Math.round(m * 255);
  }
  return out;
}

/** 面积降采样到长边不超过 maxLongEdge */
export function downscaleImage(img: FloatImage, maxLongEdge: number): FloatImage {
  const longEdge = Math.max(img.width, img.height);
  if (longEdge <= maxLongEdge) return img;
  const ratio = maxLongEdge / longEdge;
  const dw = Math.round(img.width * ratio);
  const dh = Math.round(img.height * ratio);
  const out = new Float32Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / ratio));
      const sy = Math.min(img.height - 1, Math.floor(y / ratio));
      const si = (sy * img.width + sx) * 3;
      const di = (y * dw + x) * 3;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
    }
  }
  return { width: dw, height: dh, data: out };
}

export async function loadImageFile(file: File): Promise<FloatImage> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return imageDataToFloat(imgData);
}

export function imageToCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}
