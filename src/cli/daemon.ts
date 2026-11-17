/**
 * Headless version of the app's fold loop: keeps sessions.json current
 * without the menu bar. Handy for checking milestone 2 on its own.
 */
import { Engine } from '../shared/store';
import { paths } from '../shared/paths';

const engine = new Engine();
const print = () => {
  const rows = engine.views().map((v) => `  ${v.status.padEnd(8)} ${v.project_name} — ${v.goal ?? 'goal unknown'}`);
  console.log(`[${new Date().toLocaleTimeString()}] ${rows.length} session(s)\n${rows.join('\n')}`);
};

engine.tick();
print();
console.log(`Watching ${paths().events}`);

let sinceFullTick = 0;
setInterval(() => {
  sinceFullTick += 1;
  // Fold on new events; every 15 seconds anyway, for the idle and drop rules.
  if (engine.hasNewEvents() || sinceFullTick >= 30) {
    sinceFullTick = 0;
    if (engine.tick()) print();
  }
}, 500);
