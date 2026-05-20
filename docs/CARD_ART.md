# Card Art Generator

Procedural jukebox slot card art now lives in the npm package **[`@spacedevin/juke-cards`](../packages/juke-cards/README.md)**.

See that README for API docs, deterministic seeding, font preloading, and the visual demo grid.

Quick start:

```bash
npm install @spacedevin/juke-cards
```

```js
import { generateCardArt } from '@spacedevin/juke-cards';

const { canvas, accent, bg, alt } = generateCardArt({
  titleA: 'JOHNNY B',
  titleB: 'GOODE',
  artist: 'Chuck Berry',
  code: 'A1',
});
```

Source: `packages/juke-cards/src/*.tish` (ported from the original `lib/card-art.ts`).
