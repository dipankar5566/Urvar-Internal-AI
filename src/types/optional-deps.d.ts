// Ambient declarations for optional native dependencies.
// These modules require native C++ compilation and may not be installed
// (e.g. when the project path contains spaces). The bot degrades gracefully
// when they are absent — code checks availability at runtime before use.

declare module 'sharp' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sharp: any;
  export default sharp;
}

declare module '@tensorflow/tfjs-node' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tf: any;
  export = tf;
}
