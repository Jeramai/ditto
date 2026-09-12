// The three.js addons import from 'three' while the app imports 'three/webgpu'.
// Without this alias both copies load and the renderer sees two class
// hierarchies. It has to be an exact match, or it rewrites 'three/webgpu' too.
export default {
  base: './',
  build: { target: 'esnext' },
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  server: { headers: { 'cache-control': 'no-store' } },
};
