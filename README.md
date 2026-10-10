# @sooperdoopersoftware/music-box

A rolling barrel of pins plucks a comb as it spins — a music-box visualizer
built with canvas 2D and the Web Audio API (no audio assets; every pluck is
synthesized, with delay/reverb effects). Barrels are editable and swappable,
with a couple of presets and localStorage persistence for custom ones.

Extracted from [sooperdoopersoftware.com](https://sooperdoopersoftware.com)'s
`/visuals/music-box`.

## Usage

This package ships TypeScript source directly (no build step). In a Next.js
app, add it to `transpilePackages` in `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  transpilePackages: ["@sooperdoopersoftware/music-box"],
};
```

```tsx
import { MusicBox } from "@sooperdoopersoftware/music-box";

export default function Page() {
  return <MusicBox />;
}
```

`MusicBox` uses browser-only APIs (canvas, Web Audio, localStorage) — render
it client-side only (e.g. via `next/dynamic` with `ssr: false`).

## Install

```
npm install github:sooperdoopersoftware/music-box#v0.2.0
```

## License

MIT
