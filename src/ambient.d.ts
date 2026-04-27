// Ambient type shims for dependencies that don't ship their own .d.ts.

declare module "ffmpeg-static" {
  // Resolved absolute path to the bundled ffmpeg binary. May be `null` if the
  // platform-specific optional dependency failed to install (e.g. blocked
  // network during postinstall).
  const ffmpegPath: string | null;
  export default ffmpegPath;
}
