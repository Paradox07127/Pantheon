// One-off look at the running app.
//   node probe.mjs <runDir> names <part of a name>   every visible control whose name contains it
//   node probe.mjs <runDir> eval '<page expression>' the expression's value
//   node probe.mjs <runDir> query <name> [key=value…] a daemon query
import { open } from './page.mjs';

const [runDir, mode, ...rest] = process.argv.slice(2);
const { page, query, names } = await open(runDir, { ms: 20_000 });
const value =
  mode === 'names'
    ? await names(rest.join(' '))
    : mode === 'eval'
      ? await page.evaluate(rest.join(' '))
      : mode === 'query'
        ? await query(rest[0], Object.fromEntries(rest.slice(1).map((pair) => pair.split('='))))
        : `unknown mode ${mode}; use names, eval or query`;
console.log(JSON.stringify(value, null, 2));
page.close();
