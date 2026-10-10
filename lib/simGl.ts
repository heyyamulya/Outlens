// Draws the camera (or the frozen frame) through a color matrix on the graphics chip
// (WebGL), so "through Maya's eyes" works on phones too. (A CSS/SVG filter on <video>
// worked on laptops but iPhone Safari does not apply it to live video.)

import type { Matrix } from "./cvd";

const VERTEX = `
attribute vec2 p;
varying vec2 uv;
void main() {
  uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Same math as lib/cvd.ts: to linear RGB (approximated with gamma 2.2), apply the matrix,
// back to sRGB.
const FRAGMENT = `
precision mediump float;
varying vec2 uv;
uniform sampler2D t;
uniform mat3 m;
void main() {
  vec4 c = texture2D(t, uv);
  vec3 lin = pow(c.rgb, vec3(2.2));
  vec3 outLin = clamp(m * lin, 0.0, 1.0);
  gl_FragColor = vec4(pow(outLin, vec3(1.0 / 2.2)), 1.0);
}`;

export type SimRenderer = {
  draw: (source: HTMLVideoElement | HTMLCanvasElement, matrix: Matrix) => boolean;
  dispose: () => void;
};

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("Simulation shader failed:", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

/** Sets up WebGL on `canvas`. Returns null if this device can't do it. */
export function createSimRenderer(canvas: HTMLCanvasElement): SimRenderer | null {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const matrixLoc = gl.getUniformLocation(program, "m");

  return {
    draw(source, m) {
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (!width || !height) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } catch {
        return false;
      }
      // GLSL matrices are column-major; ours are row-major.
      gl.uniformMatrix3fv(matrixLoc, false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
