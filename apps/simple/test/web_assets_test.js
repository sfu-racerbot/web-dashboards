/*
 * Consistency checks between the dashboard's HTML, CSS and JavaScript.
 *
 * A port of the car repo's src/web_dashboard/test/test_web_assets.py
 * (sfu-racerbot/Racerbot-Car-2-Workspace at 022e6fa) from pytest to plain
 * node, so this repo needs no Python. Every assertion in that file has an
 * equivalent here, in the same order and under the same name, so the two
 * can be compared side by side. See apps/simple/SOURCE.md for the mapping.
 *
 * Why these exist, in the original's words: dashboard.js looks up about
 * forty elements by id at load time and stores the results in consts; if
 * one id is renamed or dropped in the HTML, the lookup silently yields null
 * and the whole IIFE dies on the first property access -- so a single typo
 * in index.html produces a completely blank dashboard with one line in a
 * console nobody has open. That is not a failure mode worth discovering
 * trackside.
 *
 * Nothing here needs a browser, a car or any npm package:
 *
 *     node apps/simple/test/web_assets_test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');

function read(name) {
  return fs.readFileSync(path.join(WEB, name), 'utf8');
}

function idsIn(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

function idsLookedUpBy(js) {
  return new Set([...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The body of a TOP-LEVEL rule for `selector`.
 *
 * Anchored to the start of a line on purpose: the same selector also
 * appears indented inside `@media` blocks, and matching one of those would
 * test an override rather than the rule itself.
 */
function rule(css, selector) {
  const match = new RegExp(`^${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(css);
  if (!match) throw new Error(`no top-level rule for ${selector}`);
  return match[1];
}

let checks = 0;
let failures = 0;

function test(name, fn) {
  checks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

// --------------------------------------------------------------------------
// Every element the JavaScript reaches for has to exist
// --------------------------------------------------------------------------

console.log('every element the JavaScript reaches for has to exist');

for (const [script, page] of [
  ['dashboard.js', 'index.html'],
  ['panels.js', 'index.html'],
  ['camera.js', 'camera.html'],
]) {
  test(`every element ${script} looks up exists in ${page}`, () => {
    const htmlIds = new Set(idsIn(read(page)));
    const missing = [...idsLookedUpBy(read(script))].filter((id) => !htmlIds.has(id)).sort();
    assert(missing.length === 0,
      `${script} looks up ids that ${page} does not define: ${missing.join(', ')}. `
      + 'Each one is a null at load time and a blank dashboard.');
  });
}

for (const page of ['index.html', 'camera.html']) {
  test(`no duplicate ids in ${page}`, () => {
    const ids = idsIn(read(page));
    const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
    assert(duplicates.length === 0, `${page} defines these ids more than once: ${duplicates}`);
  });
}

test('the dashboard still loads its stylesheet and script', () => {
  const html = read('index.html');
  assert(html.includes('href="style.css"'));
  assert(html.includes('src="dashboard.js"'));
  assert(html.includes('src="panels.js"'));
});

test('the panel manager loads after the dashboard', () => {
  // panels.js MOVES section elements out of the sidebar. dashboard.js
  // resolves ~forty elements by id at load time and keeps the references,
  // which survive re-parenting -- but only if it ran first.
  const html = read('index.html');
  assert(html.indexOf('src="dashboard.js"') < html.indexOf('src="panels.js"'));
});

// --------------------------------------------------------------------------
// Collapsible sections
// --------------------------------------------------------------------------

console.log('\ncollapsible sections');

test('every section is a <details> element', () => {
  // Collapsing is the browser's job here, not JavaScript's -- that is what
  // gives keyboard and screen-reader behaviour for free.
  const html = read('index.html');
  for (const m of html.matchAll(/<(\w+)([^>]*\bdata-section="[^"]+")/g)) {
    assert(m[1] === 'details', `a section is a <${m[1]}>, not <details>: ${m[2]}`);
  }
});

test('every section has a digest element for its collapsed headline', () => {
  const html = read('index.html');
  const ids = new Set(idsIn(html));
  for (const m of html.matchAll(/data-section="([^"]+)"/g)) {
    assert(ids.has(`digest-${m[1]}`),
      `section '${m[1]}' has no digest-${m[1]} element, so collapsing it would hide its value entirely`);
  }
});

test('the JavaScript knows about exactly the sections that exist', () => {
  const htmlSections = new Set([...read('index.html').matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]));
  const js = read('dashboard.js');
  let block = js.slice(js.indexOf('const digestEls = {'));
  block = block.slice(0, block.indexOf('};'));
  const jsSections = new Set([...block.matchAll(/(\w+):\s*document\.getElementById/g)].map((m) => m[1]));
  const same = jsSections.size === htmlSections.size && [...jsSections].every((s) => htmlSections.has(s));
  assert(same, `digestEls covers ${[...jsSections].sort()} but the page has ${[...htmlSections].sort()}`);
});

test('a checkbox never sits inside a <summary>', () => {
  // Clicking a control inside <summary> also toggles the section, which is
  // never what the person clicking it wanted.
  for (const m of read('index.html').matchAll(/<summary\b[\s\S]*?<\/summary>/g)) {
    assert(!m[0].includes('<input'), `interactive control inside a summary: ${m[0].slice(0, 120)}`);
  }
});

// --------------------------------------------------------------------------
// The scroll bug the original UI pass existed to fix
// --------------------------------------------------------------------------

console.log('\nthe sidebar scrolls');

test('the sidebar can receive pointer events', () => {
  // The decision log had overflow-y:auto and was still impossible to
  // scroll, because #overlay was pointer-events:none and the wheel went
  // straight past it to the canvas, zooming the map instead.
  assert(!rule(read('style.css'), '#overlay').includes('pointer-events: none'),
    'the sidebar cannot receive wheel events, so nothing inside it can scroll');
});

test('the sidebar is bounded and scrolls', () => {
  // Unbounded, its bottom (the decision log, the tuning button, reset view)
  // simply ran off a short screen with no way to reach it, because
  // html/body are overflow:hidden.
  const css = read('style.css');
  assert(rule(css, '#overlay').includes('max-height'), '#overlay has no height bound');
  const panels = rule(css, '#panels');
  assert(panels.includes('overflow-y: auto'), '#panels does not scroll');
  // A flex child will not shrink below its content without this, so the
  // region would grow instead of scrolling.
  assert(panels.includes('min-height: 0'), '#panels will overflow rather than scroll');
});

test('scrollable regions are visibly scrollable', () => {
  const css = read('style.css');
  assert(css.includes('scrollbar-color'), 'no scrollbar styling: dark-theme scrollbars are invisible');
  assert(css.includes('::-webkit-scrollbar'));
});

test('the decision log scrolls', () => {
  const block = rule(read('style.css'), '.intent-log');
  assert(block.includes('overflow-y: auto'));
  assert(block.includes('max-height'));
  // `scrolls` is what carries the visible scrollbar styling.
  assert(/id="intent-log"[^>]*class="[^"]*scrolls/.test(read('index.html')),
    'the decision log is not marked as a scroll region');
});

test('the view controls are pinned outside the scroll region', () => {
  // The banner explaining why the picture looks odd, and the reset-view
  // button, are the two things that must never be what scrolled away.
  const html = read('index.html');
  // Anchor on the last </details>: every section lives inside #panels, so
  // anything after that is outside the scroll region.
  const lastSectionEnd = html.lastIndexOf('</details>');
  assert(html.indexOf('id="mode-banner"') > lastSectionEnd,
    'the mode banner is inside the scroll region and can scroll away');
  assert(html.indexOf('id="help"') > lastSectionEnd,
    'the view controls are inside the scroll region and can scroll away');
});

/**
 * The same rules Python's html.parser applies in the original test: void
 * elements never nest, `<x />` is already complete, and every other end tag
 * must close the innermost open element. Comments, doctypes, and the
 * bodies of <script>/<style> are skipped the way a parser would.
 */
function wellFormednessProblems(html) {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [];
  const problems = [];
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, '$1$3');
  for (const m of text.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosing = /\/\s*$/.test(m[3]);
    if (closing) {
      if (VOID.has(tag)) continue;
      if (!stack.length) {
        problems.push(`</${tag}> with nothing open`);
      } else if (stack[stack.length - 1] !== tag) {
        problems.push(`</${tag}> closes <${stack[stack.length - 1]}>`);
        stack.pop();
      } else {
        stack.pop();
      }
    } else if (!selfClosing && !VOID.has(tag)) {
      stack.push(tag);
    }
  }
  return { problems, unclosed: stack };
}

test('the pages are well formed', () => {
  // A stray unclosed tag reflows the whole sidebar in ways that are tedious
  // to spot by eye.
  for (const page of ['index.html', 'camera.html']) {
    const { problems, unclosed } = wellFormednessProblems(read(page));
    assert(problems.length === 0, `${page}: ${problems.join('; ')}`);
    assert(unclosed.length === 0, `${page} leaves these tags unclosed: ${unclosed}`);
  }
});

test('the well-formedness check itself catches a mis-nested tag', () => {
  // Not in the Python original, which leaned on the stdlib parser. This
  // hand-rolled one gets a check of its own so it cannot pass vacuously.
  assert(wellFormednessProblems('<div><span></div>').problems.length > 0);
  assert(wellFormednessProblems('<div><p>').unclosed.length === 2);
  assert(wellFormednessProblems('<div><img src="x"><br/><input /></div>').problems.length === 0);
});

// --------------------------------------------------------------------------
// Touch input
//
// The dashboard was mouse-and-wheel only for a long time, which meant the
// map could not be panned or zoomed on a phone at all. It is an easy
// regression to reintroduce, because on a laptop everything still works.
// --------------------------------------------------------------------------

console.log('\ntouch input');

test('the map handles pointer events, not just mouse events', () => {
  const js = read('dashboard.js');
  for (const event of ['pointerdown', 'pointermove', 'pointerup']) {
    assert(js.includes(`canvas.addEventListener('${event}'`),
      `the canvas does not listen for ${event}, so the map cannot be dragged with a finger`);
  }
  assert(!js.includes("canvas.addEventListener('mousedown'"),
    'a mouse-only drag handler is back beside the pointer handlers; two of them means '
    + 'every mouse drag pans twice as far');
});

test('the canvas claims touch gestures from the browser', () => {
  // Without touch-action:none the browser scrolls and page-zooms first and
  // the canvas never sees the gesture.
  assert(rule(read('style.css'), '#view').includes('touch-action: none'));
});

test('pinch-zoom and the wheel share one zoom implementation', () => {
  const js = read('dashboard.js');
  assert(js.split('function zoomAt(').length - 1 === 1);
  assert(js.split('view.scale = Math.min(Math.max(view.scale * factor, 2), 4000)').length - 1 === 2,
    'the two frame branches of zoomAt no longer clamp the same way');
});

// --------------------------------------------------------------------------
// The phone layout: style.css and panels.js agree on two numbers, and
// nothing but these checks makes them.
// --------------------------------------------------------------------------

console.log('\nthe phone layout');

function jsNumber(js, name) {
  const match = new RegExp(`const ${name} = ([0-9.]+);`).exec(js);
  if (!match) throw new Error(`panels.js no longer defines ${name}`);
  return parseFloat(match[1]);
}

test('the phone breakpoint agrees between the stylesheet and the script', () => {
  const width = jsNumber(read('panels.js'), 'PHONE_MAX_WIDTH');
  assert(read('style.css').includes(`@media (max-width: ${Math.trunc(width)}px)`),
    `panels.js switches to the phone layout at ${Math.trunc(width)}px but style.css has no breakpoint there`);
});

test('the half detent agrees between the stylesheet and the script', () => {
  const percent = Math.round(jsNumber(read('panels.js'), 'SHEET_HALF_FRACTION') * 100);
  assert(read('style.css').includes(`body.sheet-half #overlay { transform: translateY(${percent}%); }`),
    `panels.js settles the sheet at ${percent}% but the stylesheet puts it somewhere else`);
});

test('the sheet moves by transform only', () => {
  // Rule 2 of the stylesheet: a sheet that transitioned its height would
  // re-lay-out every row inside it on every frame of a drag.
  const css = read('style.css');
  const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
  const overlay = /#overlay \{([\s\S]*?)\}/.exec(phone);
  assert(overlay, 'the phone layout no longer restyles #overlay');
  const transition = /transition: ([^;]+);/.exec(overlay[1]);
  assert(transition, 'the sheet has no transition at all');
  for (const forbidden of ['height', 'width', 'margin', 'padding', 'all']) {
    assert(!transition[1].includes(forbidden),
      `the phone sheet animates ${forbidden}, which relayouts its contents on every frame of a drag`);
  }
});

test('the peek height is a variable both sides can read', () => {
  assert(rule(read('style.css'), ':root').includes('--sheet-peek:'));
  assert(read('panels.js').includes('--sheet-peek'));
});

test('the phone strip is filled by the dashboard', () => {
  // It is display:none on a laptop, so nothing else would notice it quietly
  // not being updated.
  const js = read('dashboard.js');
  for (const name of ['strip-dot', 'strip-state', 'strip-speed', 'strip-feeds']) {
    assert(js.includes(`getElementById('${name}')`), `${name} is never looked up`);
  }
  assert(js.includes('stripState.textContent'), 'the phone strip is never written to');
});

// --------------------------------------------------------------------------
// The type scale
// --------------------------------------------------------------------------

console.log('\nthe type scale');

test('every font size goes through the type scale', () => {
  const literals = [...new Set((read('style.css').match(/font-size: [0-9.]+px/g) || []))].sort();
  assert(literals.length === 0,
    `these font sizes bypass the type scale and will not respond to the breakpoints: ${literals}`);
});

test('the phone breakpoint rescales every size in the scale', () => {
  const css = read('style.css');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('html, body {'));
  const declared = new Set([...root.matchAll(/(--fs-[a-z-]+):/g)].map((m) => m[1]));
  const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
  const phoneBlock = phone.slice(0, phone.indexOf('\n}\n'));
  const restated = new Set([...phoneBlock.matchAll(/(--fs-[a-z-]+):/g)].map((m) => m[1]));
  const missing = [...declared].filter((t) => !restated.has(t)).sort();
  assert(missing.length === 0,
    `these type-scale tokens are never re-stated for a phone: ${missing}`);
});

test('the stylesheet has balanced braces', () => {
  const css = read('style.css');
  assert(css.split('{').length === css.split('}').length, 'unbalanced braces in style.css');
});

// --------------------------------------------------------------------------
// The measuring tool and the map panel
// --------------------------------------------------------------------------

console.log('\nthe measuring tool and the map panel');

test('the measure module loads before the dashboard', () => {
  // dashboard.js reads window.__measure while it is initialising, so
  // measure.js has to have run first. Matched on the <script> tags
  // themselves, not the first mention of each filename.
  const scripts = [...read('index.html').matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert(scripts.includes('measure.js'), 'index.html never loads measure.js');
  assert(scripts.includes('dashboard.js'));
  assert(scripts.indexOf('measure.js') < scripts.indexOf('dashboard.js'),
    `measure.js must be loaded before dashboard.js; order is ${scripts}`);
});

test('the script order is exactly measure.js -> dashboard.js -> panels.js', () => {
  // The two ordering checks above, stated as one sequence. Not a separate
  // assertion in the Python original; added because it is the single fact
  // docs/web-dashboard.md quotes.
  const scripts = [...read('index.html').matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert(JSON.stringify(scripts) === JSON.stringify(['measure.js', 'dashboard.js', 'panels.js']),
    `script order is ${scripts}`);
});

test('the screen-to-world inverse exists exactly once', () => {
  const js = read('dashboard.js');
  for (const fn of ['function canvasToWorld(', 'function canvasToBody(', 'function canvasToActive(']) {
    assert(js.split(fn).length - 1 === 1, `${fn} is defined ${js.split(fn).length - 1} times`);
  }
});

test('the measurement overlay never uses a decision colour', () => {
  // Colour means state on this page, never decoration: green, amber and
  // red are reserved for what the CAR has decided.
  const js = read('dashboard.js');
  const start = js.indexOf('function drawMeasure(');
  const end = js.indexOf('function drawMeasureLabel(');
  const body = js.slice(start, end) + js.slice(end, js.indexOf('\n  }', end));
  for (const forbidden of ['HUD.go', 'HUD.warn', 'HUD.bad']) {
    assert(!body.includes(forbidden),
      `the measurement overlay uses ${forbidden}, which belongs to what the car decided`);
  }
});

test('the measurement readout is pinned outside the scroll region', () => {
  const html = read('index.html');
  assert(html.includes('id="measure-panel"'));
  assert(html.indexOf('id="measure-panel"') > html.indexOf('data-section="maps"'));
  assert(rule(read('style.css'), '#measure-panel').includes('position: fixed'));
});

test('the delete confirmation is a text field, not a checkbox', () => {
  assert(read('dashboard.js').includes('map-confirm-input'));
  assert(read('style.css').includes('map-confirm-input'));
});

test('the three map actions are separate blocks', () => {
  const html = read('index.html');
  for (const block of ['map-clear-view', 'map-reset-slam', 'map-delete-block']) {
    assert(html.includes(`id="${block}"`), `${block} is missing from the map section`);
  }
});

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
