# chart-recorder

`<chart-recorder>` is a dependency-free web component that renders the Model 209 circular chart recorder. It keeps the last N revolutions on the chart instead of putting on a fresh chart each turn. The trace is coloured by age: it starts at the first of `colors` at the pen, shifts through the gradient and fades out over `revolutions` turns (default 10), then is dropped. Colour tells you when each part of the trace was drawn.

`index.html` is the demo, ported from the original artifact. Modules don't load over `file://`, so serve the folder first:

```sh
python3 -m http.server   # then open http://localhost:8000
```

## Usage

```html
<script type="module" src="chart-recorder.js"></script>
<chart-recorder id="rec" style-name="classic" max="200" unit="°F" alert-at="160"></chart-recorder>
<script type="module">
  const rec = document.getElementById('rec');
  rec.configure({ revolutions: 10, period: 24 * 3600e3, divisions: 24 });
  setInterval(() => rec.push(readSensor()), 1000);
</script>
```

It works in React and other frameworks as a plain element. Hold a ref and call `configure()` and `push()` on it.

## API

| Member | |
|---|---|
| `configure(options)` | Merge options (see below). Returns the element. |
| `push(value, t = clock())` | Record a value. `null` breaks the line. Timestamps must not go backwards. |
| `setData([{ t, v }])` | Replace all data, e.g. to backfill history. |
| `clear()` | Drop all history and put on a fresh chart. |
| `getSamples(since)` | Recorded `[{ t, v }]` with `t >= since`. |
| `value`, `chartStart`, `options` | Latest value, chart start time, current options. |
| `palette` | Resolved CSS colours, newest to oldest, for legends. |

## Options

| Option | Default | |
|---|---|---|
| `style` | `'classic'` | `'classic'` (paper, swinging pen arm) or `'scope'` (dark instrument). Attribute: `style-name`. |
| `motion` | `'dial'` | Scope only: `'dial'` turns the chart, `'sweep'` turns the pen. |
| `period` | 24 h | Milliseconds per revolution. Divisions align to local clock time (`utc: true` for UTC). |
| `divisions` | `24` | Labelled time divisions (24 = hours, 60 = minutes or seconds). |
| `min`, `max`, `unit` | `0`, `100`, `''` | Value scale. |
| `alertAt` | `null` | Value for the dashed alert ring. Scope's pen and readout turn red above it. |
| `revolutions` | `10` | Turns kept on the chart, including the one just drawn. |
| `gradientMode` | `'smooth'` | `'smooth'` colours by exact age. `'stepped'` gives one colour per turn. |
| `colors` | per style | Gradient stops, newest to oldest. The first is also the pen tip colour. |
| `opacity` | `[1, 0.12]` | Opacity at the newest and oldest ends of the trace. |
| `resolution` | `720` | Stored points per revolution. Faster pushes are coalesced. |
| `clock` | `Date.now` | Time source. Swap it for simulated or replayed time. |
| `chartName`, `chartLabel`, `subLabel` | `'CHART 209'`, derived, derived | Printed chart labels. |
| `formatTick`, `formatValue`, `fonts` | | Label formatting and font stacks. |
