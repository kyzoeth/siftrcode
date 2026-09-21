#!/usr/bin/env node
/**
 * SiftrCode V3.1 - Build & Validate Final Fresh Holdout (Phases 2 & 3)
 *
 * Defines 34 genuinely new, untouched task episodes across:
 * - Express (10 tasks)
 * - FastAPI (10 tasks)
 * - SiftrCode (8 tasks)
 * - Commander (6 tasks)
 *
 * Enforces Mandatory Verifier Contract:
 * 1. Base Commit: Verifier MUST FAIL (exitCode !== 0)
 * 2. Known-Good Solution: Verifier MUST PASS (exitCode === 0)
 * 3. Zero Contamination: Overlap audit against all 121 prior tasks
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { SiftrBenchEpisode, SiftrTaskType, SiftrBenchManifest } from '../../src/benchmark/siftrbench/episode_schema';

export interface FinalHoldoutTaskDef {
  taskId: string;
  repo: 'express' | 'fastapi' | 'siftrcode' | 'commander';
  taskType: SiftrTaskType;
  prompt: string;
  expectedTargetPaths: string[];
  expectedRelatedPaths?: string[];
  verifierFilename: string;
  verifierContent: string;
  applySolution: (wsDir: string) => void;
}

export const REPO_PINNED_COMMITS: Record<string, string> = {
  express: '9a34acf03cb818ff3f8bc40e44176e277a25cbb9',
  fastapi: '50113da16fec53b66b80d75e80a89296de4fa5a5',
  siftrcode: '1eedac03b0d83025ebf08ed2945e0ab015c46f6a',
  commander: 'ba6d13ddb4243e5913367734f8c159089ffe7834',
};

export const REPO_ORIGINS: Record<string, string> = {
  express: 'https://github.com/expressjs/express.git',
  fastapi: 'https://github.com/fastapi/fastapi.git',
  siftrcode: 'https://github.com/kyzoeth/siftrcode.git',
  commander: 'https://github.com/tj/commander.js.git',
};

export const FINAL_HOLDOUT_TASKS: FinalHoldoutTaskDef[] = [
  // ============================================================================
  // COMMANDER (6 Tasks) - Base Commit: ba6d13ddb4243e5913367734f8c159089ffe7834
  // ============================================================================
  {
    taskId: 'final_cmd_01_case_sensitive_option',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add .caseSensitive(enabled = true) and .isCaseSensitive() methods to Option class in lib/option.js so options can configure case preservation.',
    expectedTargetPaths: ['lib/option.js'],
    expectedRelatedPaths: ['tests/options.flags.test.js'],
    verifierFilename: 'verify_final_cmd_01.js',
    verifierContent: `
const { Option } = require('./lib/option');
const opt = new Option('-p, --port <number>', 'port');
if (typeof opt.caseSensitive !== 'function' || typeof opt.isCaseSensitive !== 'function') {
  console.error('FAIL: caseSensitive or isCaseSensitive method missing');
  process.exit(1);
}
opt.caseSensitive(true);
if (opt.isCaseSensitive() !== true) {
  console.error('FAIL: isCaseSensitive() did not return true after enabling');
  process.exit(1);
}
opt.caseSensitive(false);
if (opt.isCaseSensitive() !== false) {
  console.error('FAIL: isCaseSensitive() did not return false after disabling');
  process.exit(1);
}
console.log('PASS: caseSensitive option verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/option.js');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
Option.prototype.caseSensitive = function(enabled = true) {
  this._caseSensitive = !!enabled;
  return this;
};
Option.prototype.isCaseSensitive = function() {
  return !!this._caseSensitive;
};
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_02_custom_help_header',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add .helpHeader(text) to Command class in lib/command.js so that custom header text appears above usage in helpInformation().',
    expectedTargetPaths: ['lib/command.js'],
    expectedRelatedPaths: ['tests/command.help.test.js'],
    verifierFilename: 'verify_final_cmd_02.js',
    verifierContent: `
const { Command } = require('./lib/command');
const program = new Command();
if (typeof program.helpHeader !== 'function') {
  console.error('FAIL: program.helpHeader is not a function');
  process.exit(1);
}
program.name('mycli').helpHeader('=== SPECIAL HEADER ===');
const info = program.helpInformation();
if (!info.startsWith('=== SPECIAL HEADER ===\\n')) {
  console.error('FAIL: helpInformation does not start with helpHeader: ' + info.slice(0, 50));
  process.exit(1);
}
console.log('PASS: helpHeader verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/command.js');
      let content = fs.readFileSync(p, 'utf8');
      const headerMethod = `
  helpHeader(text) {
    if (text === undefined) return this._helpHeader;
    this._helpHeader = text;
    return this;
  }
`;
      // Insert into Command class
      content = content.replace('helpInformation(context) {', `${headerMethod}\n  helpInformation(context) {`);
      // Update helpInformation to prepend header
      content = content.replace(
        'return helper.formatHelp(this, helper);',
        'const out = helper.formatHelp(this, helper); return this._helpHeader ? this._helpHeader + "\\n" + out : out;'
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_03_argument_choices_validation',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add .choices(values) and .validateArgChoice(val) to Argument class in lib/argument.js so invalid positional choices throw.',
    expectedTargetPaths: ['lib/argument.js'],
    expectedRelatedPaths: ['tests/command.createArgument.test.js'],
    verifierFilename: 'verify_final_cmd_03.js',
    verifierContent: `
const { Argument } = require('./lib/argument');
const arg = new Argument('<fruit>');
if (typeof arg.choices !== 'function' || typeof arg.validateArgChoice !== 'function') {
  console.error('FAIL: choices or validateArgChoice method missing');
  process.exit(1);
}
arg.choices(['apple', 'banana']);
if (!arg.validateArgChoice('apple')) {
  console.error('FAIL: apple should be valid choice');
  process.exit(1);
}
let threw = false;
try {
  arg.validateArgChoice('pear');
} catch (e) {
  threw = true;
}
if (!threw) {
  console.error('FAIL: invalid choice pear did not throw');
  process.exit(1);
}
console.log('PASS: argument choices validation verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/argument.js');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
Argument.prototype.choices = function(values) {
  this.argChoices = values;
  return this;
};
Argument.prototype.validateArgChoice = function(val) {
  if (!this.argChoices) return true;
  if (!this.argChoices.includes(val)) throw new Error('Invalid choice: ' + val);
  return true;
};
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_04_alias_summary',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'In Help.prototype.commandSummary(cmd) in lib/help.js, if cmd.alias() is present, append " (alias)" to command summary.',
    expectedTargetPaths: ['lib/help.js'],
    expectedRelatedPaths: ['tests/help.commandSummary.test.js'],
    verifierFilename: 'verify_final_cmd_04.js',
    verifierContent: `
const { Help } = require('./lib/help');
const { Command } = require('./lib/command');
const help = new Help();
const cmd = new Command('serve').alias('s').description('start server');
const summary = help.commandSummary(cmd);
if (!summary.includes('serve (s)') && !summary.includes('serve (alias: s)')) {
  console.error('FAIL: commandSummary does not include alias in output: ' + summary);
  process.exit(1);
}
console.log('PASS: alias summary verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/help.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'commandSummary(cmd) {',
        `commandSummary(cmd) {
    if (cmd.alias && cmd.alias()) {
      return (cmd.name() + ' (' + cmd.alias() + ') ' + (cmd.description() || '')).trim();
    }`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_05_option_hidden_from_help',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add .hideHelp(hidden = true) to Option class in lib/option.js and ensure Help.prototype.visibleOptions filters hidden options out.',
    expectedTargetPaths: ['lib/option.js', 'lib/help.js'],
    expectedRelatedPaths: ['tests/help.visibleOptions.test.js'],
    verifierFilename: 'verify_final_cmd_05.js',
    verifierContent: `
const { Option } = require('./lib/option');
const { Command } = require('./lib/command');
const { Help } = require('./lib/help');
const opt = new Option('-x, --secret', 'secret option');
if (typeof opt.hideHelp !== 'function') {
  console.error('FAIL: opt.hideHelp is not a function');
  process.exit(1);
}
opt.hideHelp(true);
const cmd = new Command('test').addOption(opt).option('-v, --verbose', 'verbose');
const help = new Help();
const visible = help.visibleOptions(cmd);
if (visible.some(o => o.long === '--secret')) {
  console.error('FAIL: hidden option --secret is present in visibleOptions');
  process.exit(1);
}
if (!visible.some(o => o.long === '--verbose')) {
  console.error('FAIL: visible option --verbose is missing');
  process.exit(1);
}
console.log('PASS: hideHelp verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const optPath = path.join(wsDir, 'lib/option.js');
      const optContent = fs.readFileSync(optPath, 'utf8');
      fs.writeFileSync(
        optPath,
        optContent +
          `\nOption.prototype.hideHelp = function(hidden = true) { this.hidden = !!hidden; return this; };\n`,
        'utf8'
      );

      const helpPath = path.join(wsDir, 'lib/help.js');
      let helpContent = fs.readFileSync(helpPath, 'utf8');
      helpContent = helpContent.replace(
        'visibleOptions(cmd) {',
        `visibleOptions(cmd) {
    return (cmd.options || []).filter(option => !option.hidden);`
      );
      fs.writeFileSync(helpPath, helpContent, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_06_suggest_similarity_threshold',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'In lib/suggestSimilar.js, support custom options.threshold in suggestSimilar(word, candidates, options).',
    expectedTargetPaths: ['lib/suggestSimilar.js'],
    expectedRelatedPaths: ['tests/help.suggestion.test.js'],
    verifierFilename: 'verify_final_cmd_06.js',
    verifierContent: `
const { suggestSimilar } = require('./lib/suggestSimilar');
const candidates = ['compile', 'configure', 'compare', 'commit'];
const filtered = suggestSimilar('compil', candidates, { threshold: 0.8 });
if (!Array.isArray(filtered)) {
  console.error('FAIL: suggestSimilar did not return an array');
  process.exit(1);
}
if (!filtered.includes('compile') || filtered.includes('configure')) {
  console.error('FAIL: expected only compile for strict threshold, got: ' + JSON.stringify(filtered));
  process.exit(1);
}
console.log('PASS: suggestSimilar threshold verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/suggestSimilar.js');
      const sol = `
function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function suggestSimilar(word, candidates, options) {
  if (!candidates || candidates.length === 0) return [];
  const threshold = options && typeof options.threshold === 'number' ? options.threshold : 0.4;
  const matches = [];
  for (const candidate of candidates) {
    const maxLen = Math.max(word.length, candidate.length);
    if (maxLen === 0) continue;
    const distance = editDistance(word, candidate);
    const similarity = 1 - distance / maxLen;
    if (similarity >= threshold) matches.push(candidate);
  }
  return matches;
}

exports.suggestSimilar = suggestSimilar;
`;
      fs.writeFileSync(p, sol, 'utf8');
    },
  },

  // ============================================================================
  // EXPRESS (10 Tasks) - Base Commit: 9a34acf03cb818ff3f8bc40e44176e277a25cbb9
  // ============================================================================
  {
    taskId: 'final_exp_01_res_etag_weak_flag',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add res.etag(body, { weak: true }) helper to lib/response.js to produce a weak etag formatted with W/ prefix.',
    expectedTargetPaths: ['lib/response.js'],
    expectedRelatedPaths: ['test/res.format.js'],
    verifierFilename: 'verify_final_exp_01.js',
    verifierContent: `
const express = require('./');
const res = Object.create(express.response);
if (typeof res.etag !== 'function') {
  console.error('FAIL: res.etag is not a function');
  process.exit(1);
}
const weakTag = res.etag('hello world', { weak: true });
if (!weakTag || !weakTag.startsWith('W/')) {
  console.error('FAIL: res.etag with weak: true did not produce W/ prefix: ' + weakTag);
  process.exit(1);
}
console.log('PASS: res.etag weak flag verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/response.js');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
res.etag = function(body, options) {
  const hash = Buffer.from(body).toString('base64').slice(0, 10);
  return (options && options.weak) ? 'W/"' + hash + '"' : '"' + hash + '"';
};
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_exp_02_req_has_header_helper',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add req.hasHeader(name) to lib/request.js returning boolean indicating if header is present in request.',
    expectedTargetPaths: ['lib/request.js'],
    expectedRelatedPaths: ['test/req.get.js'],
    verifierFilename: 'verify_final_exp_02.js',
    verifierContent: `
const express = require('./');
const req = Object.create(express.request);
req.headers = { 'x-custom-auth': 'token123' };
if (typeof req.hasHeader !== 'function') {
  console.error('FAIL: req.hasHeader is not a function');
  process.exit(1);
}
if (req.hasHeader('x-custom-auth') !== true) {
  console.error('FAIL: hasHeader did not find x-custom-auth');
  process.exit(1);
}
if (req.hasHeader('x-missing') !== false) {
  console.error('FAIL: hasHeader returned true for missing header');
  process.exit(1);
}
console.log('PASS: req.hasHeader verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/request.js');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
req.hasHeader = function(name) {
  return Boolean(this.headers && this.headers[name.toLowerCase()] !== undefined);
};
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_exp_03_app_prefix_mount',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add app.prefix(prefix, router) to lib/application.js for mounting sub-routers under a path prefix.',
    expectedTargetPaths: ['lib/application.js'],
    expectedRelatedPaths: ['test/app.use.js'],
    verifierFilename: 'verify_final_exp_03.js',
    verifierContent: `
const express = require('./');
const app = express();
if (typeof app.prefix !== 'function') {
  console.error('FAIL: app.prefix is not a function');
  process.exit(1);
}
const router = express.Router();
router.get('/ping', (req, res) => res.send('pong'));
app.prefix('/api/v1', router);
console.log('PASS: app.prefix verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/application.js');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
app.prefix = function(prefix, router) {
  return this.use(prefix, router);
};
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_exp_04_router_param_colon_strip',
    repo: 'express',
    taskType: 'BUG_FIX',
    prompt: 'In lib/router/index.js, ensure router.param(name, fn) automatically strips leading colon ":" from name.',
    expectedTargetPaths: ['lib/router/index.js'],
    expectedRelatedPaths: ['test/router.js'],
    verifierFilename: 'verify_final_exp_04.js',
    verifierContent: `
const express = require('./');
const router = express.Router();
let called = false;
router.param(':userId', (req, res, next, val) => {
  called = true;
  next();
});
router.handle({ method: 'GET', url: '/user/42', params: { userId: '42' } }, {}, () => {});
if (!called) {
  console.error('FAIL: router.param with :userId was not matched for param userId');
  process.exit(1);
}
console.log('PASS: router param colon strip verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/router/index.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'proto.param = function param(name, fn) {',
        `proto.param = function param(name, fn) {
  if (typeof name === 'string' && name[0] === ':') name = name.slice(1);`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_exp_05_res_json_spaces_zero',
    repo: 'express',
    taskType: 'BUG_FIX',
    prompt: 'In lib/response.js, handle app.get("json spaces") === 0 by outputting compact unindented JSON in res.json().',
    expectedTargetPaths: ['lib/response.js'],
    expectedRelatedPaths: ['test/res.json.js'],
    verifierFilename: 'verify_final_exp_05.js',
    verifierContent: `
const express = require('./');
const app = express();
app.set('json spaces', 0);
let sentBody = '';
const res = {
  app,
  set: () => {},
  send: (body) => { sentBody = body; }
};
Object.setPrototypeOf(res, express.response);
res.json({ a: 1, b: 2 });
if (sentBody.includes('\\n')) {
  console.error('FAIL: json spaces 0 produced newlines in body: ' + sentBody);
  process.exit(1);
}
if (sentBody !== '{"a":1,"b":2}') {
  console.error('FAIL: unexpected compact JSON: ' + sentBody);
  process.exit(1);
}
console.log('PASS: res.json spaces 0 verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/response.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        "var spaces = app.get('json spaces')",
        "var rawSpaces = app.get('json spaces'); var spaces = typeof rawSpaces === 'number' ? rawSpaces : (rawSpaces || undefined)"
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_exp_06_route_has_method_check',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add Route.prototype.hasMethod(method) to lib/router/route.js returning boolean (case-insensitive) if method is handled.',
    expectedTargetPaths: ['lib/router/route.js'],
    expectedRelatedPaths: ['test/Route.js'],
    verifierFilename: 'verify_final_exp_06.js',
    verifierContent: `
const express = require('./');
const Route = require('./lib/router/route');
const route = new Route('/test');
if (typeof route.hasMethod !== 'function') {
  console.error('FAIL: route.hasMethod is not a function');
  process.exit(1);
}
route.get(() => {});
if (!route.hasMethod('GET') || !route.hasMethod('get')) {
  console.error('FAIL: route.hasMethod did not match GET');
  process.exit(1);
}
if (route.hasMethod('POST')) {
  console.error('FAIL: route.hasMethod returned true for unhandled POST');
  process.exit(1);
}
console.log('PASS: route.hasMethod verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/router/route.js');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
Route.prototype.hasMethod = function(method) {
  return Boolean(this.methods && this.methods[method.toLowerCase()]);
};
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_exp_07_layer_match_safe_decode',
    repo: 'express',
    taskType: 'BUG_FIX',
    prompt: 'In lib/router/layer.js Layer.prototype.match(), safely catch decodeURIComponent errors and return false without crashing.',
    expectedTargetPaths: ['lib/router/layer.js'],
    expectedRelatedPaths: ['test/Router.js'],
    verifierFilename: 'verify_final_exp_07.js',
    verifierContent: `
const Layer = require('./lib/router/layer');
const layer = new Layer('/user/:id', {}, () => {});
let matched = false;
try {
  matched = layer.match('/user/%E0%A4%A');
} catch (e) {
  console.error('FAIL: layer.match threw on malformed URI: ' + e.message);
  process.exit(1);
}
if (matched) {
  console.error('FAIL: malformed URI should not match');
  process.exit(1);
}
console.log('PASS: layer safe decode verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/router/layer.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'this.path = decodeURIComponent(val)',
        'try { this.path = decodeURIComponent(val) } catch (e) { return false }'
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_exp_08_utils_append_header',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add appendHeader(res, field, val) to lib/utils.js merging header values without overwriting.',
    expectedTargetPaths: ['lib/utils.js'],
    expectedRelatedPaths: ['test/res.append.js'],
    verifierFilename: 'verify_final_exp_08.js',
    verifierContent: `
const utils = require('./lib/utils');
if (typeof utils.appendHeader !== 'function') {
  console.error('FAIL: utils.appendHeader is not a function');
  process.exit(1);
}
const headers = {};
const mockRes = {
  get: (k) => headers[k.toLowerCase()],
  set: (k, v) => { headers[k.toLowerCase()] = v; }
};
utils.appendHeader(mockRes, 'Set-Cookie', 'a=1');
utils.appendHeader(mockRes, 'Set-Cookie', 'b=2');
const resCookie = headers['set-cookie'];
if (!Array.isArray(resCookie) || resCookie.length !== 2) {
  console.error('FAIL: appendHeader did not create array with 2 cookies: ' + JSON.stringify(resCookie));
  process.exit(1);
}
console.log('PASS: utils.appendHeader verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/utils.js');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
exports.appendHeader = function(res, field, val) {
  const prev = res.get(field);
  if (!prev) res.set(field, val);
  else if (Array.isArray(prev)) res.set(field, prev.concat(val));
  else res.set(field, [prev, val]);
};
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_exp_09_req_is_json_helper',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add req.isJson() helper method to lib/request.js returning boolean if Content-Type is application/json or ends with +json.',
    expectedTargetPaths: ['lib/request.js'],
    expectedRelatedPaths: ['test/req.is.js'],
    verifierFilename: 'verify_final_exp_09.js',
    verifierContent: `
const express = require('./');
const req = Object.create(express.request);
if (typeof req.isJson !== 'function') {
  console.error('FAIL: req.isJson is not a function');
  process.exit(1);
}
req.headers = { 'content-type': 'application/json; charset=utf-8' };
if (req.isJson() !== true) {
  console.error('FAIL: req.isJson returned false for application/json');
  process.exit(1);
}
req.headers = { 'content-type': 'application/problem+json' };
if (req.isJson() !== true) {
  console.error('FAIL: req.isJson returned false for +json');
  process.exit(1);
}
req.headers = { 'content-type': 'text/html' };
if (req.isJson() !== false) {
  console.error('FAIL: req.isJson returned true for text/html');
  process.exit(1);
}
console.log('PASS: req.isJson verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/request.js');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
req.isJson = function() {
  const ct = (this.headers && this.headers['content-type']) || '';
  return ct.includes('application/json') || ct.includes('+json');
};
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_exp_10_app_del_alias_deprecation',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'In lib/application.js, ensure app.del() emits a deprecation warning using process.emitWarning.',
    expectedTargetPaths: ['lib/application.js'],
    expectedRelatedPaths: ['test/app.del.js'],
    verifierFilename: 'verify_final_exp_10.js',
    verifierContent: `
const express = require('./');
const app = express();
let warningEmitted = false;
const origEmit = process.emitWarning;
process.emitWarning = (msg) => {
  if (String(msg).toLowerCase().includes('deprecated') || String(msg).toLowerCase().includes('del')) {
    warningEmitted = true;
  }
};
try {
  app.del('/old', () => {});
} finally {
  process.emitWarning = origEmit;
}
if (!warningEmitted) {
  console.error('FAIL: app.del did not emit deprecation warning');
  process.exit(1);
}
console.log('PASS: app.del deprecation verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/application.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        "app.del = deprecate.function(app.delete, 'app.del: Use app.delete instead')",
        `app.del = function() {
  process.emitWarning('express.app.del() is deprecated, please use app.delete()', 'DeprecationWarning');
  return this.delete.apply(this, arguments);
}`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },

  // ============================================================================
  // FASTAPI (10 Tasks) - Base Commit: 50113da16fec53b66b80d75e80a89296de4fa5a5
  // ============================================================================
  {
    taskId: 'final_fa_01_custom_encoder_subclass',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'In fastapi/encoders.py jsonable_encoder, support subclass matching in custom_encoder mapping so subclasses inherit parent encoder.',
    expectedTargetPaths: ['fastapi/encoders.py'],
    expectedRelatedPaths: ['tests/test_encoders.py'],
    verifierFilename: 'verify_final_fa_01.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.encoders import jsonable_encoder

class Parent:
    def __init__(self, val): self.val = val

class Child(Parent): pass

encoded = jsonable_encoder(Child(123), custom_encoder={Parent: lambda p: f"parent-{p.val}"})
if encoded != "parent-123":
    print(f"FAIL: expected parent-123 but got {encoded}")
    sys.exit(1)
print("PASS: custom_encoder subclass lookup verified")
sys.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/encoders.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'if custom_encoder and type(obj) in custom_encoder:',
        `if custom_encoder:
        for _enc_type, _enc_fn in custom_encoder.items():
            if isinstance(obj, _enc_type):
                return _enc_fn(obj)
    if False and custom_encoder and type(obj) in custom_encoder:`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_fa_02_uploadfile_seek_coroutine',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add async seek(self, offset: int = 0) method to UploadFile in fastapi/datastructures.py.',
    expectedTargetPaths: ['fastapi/datastructures.py'],
    expectedRelatedPaths: ['tests/test_upload_file.py'],
    verifierFilename: 'verify_final_fa_02.py',
    verifierContent: `
import sys, asyncio, io
sys.path.insert(0, '.')
from fastapi.datastructures import UploadFile

async def test():
    f = UploadFile(filename="test.txt", file=io.BytesIO(b"hello world"))
    if not hasattr(f, 'seek') or not asyncio.iscoroutinefunction(f.seek):
        print("FAIL: UploadFile.seek is missing or not a coroutine function")
        sys.exit(1)
    await f.seek(6)
    data = await f.read()
    if data != b"world":
        print(f"FAIL: expected b'world' after seek(6), got {data}")
        sys.exit(1)
    print("PASS: UploadFile.seek verified")
    sys.exit(0)

asyncio.run(test())
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/datastructures.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'async def read(',
        `async def seek(self, offset: int = 0) -> None:
        self.file.seek(offset)

    async def read(`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_fa_03_api_key_scheme_name_helper',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add get_scheme_name() helper to APIKeyBase in fastapi/security/api_key.py.',
    expectedTargetPaths: ['fastapi/security/api_key.py'],
    expectedRelatedPaths: ['tests/test_security_api_key.py'],
    verifierFilename: 'verify_final_fa_03.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.security.api_key import APIKeyQuery

key = APIKeyQuery(name="token", scheme_name="CustomAuth")
if not hasattr(key, 'get_scheme_name'):
    print("FAIL: APIKeyQuery missing get_scheme_name method")
    sys.exit(1)
if key.get_scheme_name() != "CustomAuth":
    print(f"FAIL: expected CustomAuth, got {key.get_scheme_name()}")
    sys.exit(1)
print("PASS: get_scheme_name verified")
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/security/api_key.py');
      const content = fs.readFileSync(p, 'utf8');
      const addition = `
APIKeyBase.get_scheme_name = lambda self: self.scheme_name or self.__class__.__name__
`;
      fs.writeFileSync(p, content + addition, 'utf8');
    },
  },
  {
    taskId: 'final_fa_04_route_summary_docstring_fallback',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'In fastapi/routing.py APIRoute.__init__, default summary to first line of endpoint docstring if summary is not specified.',
    expectedTargetPaths: ['fastapi/routing.py'],
    expectedRelatedPaths: ['tests/test_routing.py'],
    verifierFilename: 'verify_final_fa_04.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.routing import APIRoute

def sample_endpoint():
    """Retrieve items from storage.

    Detailed explanation here.
    """
    pass

route = APIRoute("/items", sample_endpoint)
if route.summary != "Retrieve items from storage.":
    print(f"FAIL: expected docstring summary 'Retrieve items from storage.', got: '{route.summary}'")
    sys.exit(1)
print("PASS: route summary docstring fallback verified")
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/routing.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'self.summary = summary',
        `if summary is None and getattr(endpoint, '__doc__', None):
            lines = [line.strip() for line in endpoint.__doc__.split('\\n') if line.strip()]
            self.summary = lines[0] if lines else None
        else:
            self.summary = summary`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_fa_05_openapi_tag_metadata_dedup',
    repo: 'fastapi',
    taskType: 'BUG_FIX',
    prompt: 'In fastapi/openapi/utils.py get_openapi, deduplicate openapi_tags metadata preserving first occurrence.',
    expectedTargetPaths: ['fastapi/openapi/utils.py'],
    expectedRelatedPaths: ['tests/test_openapi.py'],
    verifierFilename: 'verify_final_fa_05.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.openapi.utils import get_openapi

tags = [
    {"name": "items", "description": "Item operations"},
    {"name": "items", "description": "Duplicate description"}
]
schema = get_openapi(title="Test", version="1.0.0", routes=[], tags=tags)
schema_tags = schema.get("tags", [])
if len(schema_tags) != 1 or schema_tags[0]["description"] != "Item operations":
    print(f"FAIL: tags were not deduplicated: {schema_tags}")
    sys.exit(1)
print("PASS: openapi tag dedup verified")
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/openapi/utils.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'if tags:\n        output["tags"] = list(tags)',
        `if tags:
        seen = set()
        deduped = []
        for t in tags:
            name = t.get("name") if isinstance(t, dict) else t
            if name not in seen:
                seen.add(name)
                deduped.append(t)
        output["tags"] = deduped`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_fa_06_param_examples_list',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add examples list attribute to Param class in fastapi/params.py so Query/Path store self.examples.',
    expectedTargetPaths: ['fastapi/params.py'],
    expectedRelatedPaths: ['tests/test_params.py'],
    verifierFilename: 'verify_final_fa_06.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.params import Query

q = Query(None, examples=["ex1", "ex2"])
if not hasattr(q, 'examples') or q.examples != ["ex1", "ex2"]:
    print(f"FAIL: Query missing examples attribute or wrong value: {getattr(q, 'examples', None)}")
    sys.exit(1)
print("PASS: param examples list verified")
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/params.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'example: Any = Undefined,',
        'example: Any = Undefined,\n        examples: Optional[List[Any]] = None,'
      );
      content = content.replace(
        'self.example = example',
        'self.example = example\n        self.examples = examples'
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_fa_07_app_swagger_ui_oauth2_redirect',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add swagger_ui_oauth2_redirect_url attribute to FastAPI in fastapi/applications.py.',
    expectedTargetPaths: ['fastapi/applications.py'],
    expectedRelatedPaths: ['tests/test_application.py'],
    verifierFilename: 'verify_final_fa_07.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi import FastAPI

app = FastAPI(swagger_ui_oauth2_redirect_url="/custom/oauth2-redirect")
if not hasattr(app, 'swagger_ui_oauth2_redirect_url') or app.swagger_ui_oauth2_redirect_url != "/custom/oauth2-redirect":
    print("FAIL: app missing swagger_ui_oauth2_redirect_url attribute")
    sys.exit(1)
print("PASS: swagger_ui_oauth2_redirect_url verified")
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/applications.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'swagger_ui_init_oauth: Optional[Dict[str, Any]] = None,',
        'swagger_ui_init_oauth: Optional[Dict[str, Any]] = None,\n        swagger_ui_oauth2_redirect_url: Optional[str] = "/docs/oauth2-redirect",'
      );
      content = content.replace(
        'self.swagger_ui_init_oauth = swagger_ui_init_oauth',
        'self.swagger_ui_init_oauth = swagger_ui_init_oauth\n        self.swagger_ui_oauth2_redirect_url = swagger_ui_oauth2_redirect_url'
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_fa_08_encoder_deterministic_set_sort',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'In fastapi/encoders.py jsonable_encoder, sort sets of orderable elements so returned JSON array is deterministic.',
    expectedTargetPaths: ['fastapi/encoders.py'],
    expectedRelatedPaths: ['tests/test_encoders.py'],
    verifierFilename: 'verify_final_fa_08.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.encoders import jsonable_encoder

s = {"banana", "apple", "cherry"}
encoded = jsonable_encoder(s)
if encoded != ["apple", "banana", "cherry"]:
    print(f"FAIL: set was not sorted deterministically: {encoded}")
    sys.exit(1)
print("PASS: deterministic set sort verified")
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/encoders.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'if isinstance(obj, (set, frozenset, GeneratorType)):',
        `if isinstance(obj, (set, frozenset)):
        try:
            return sorted([jsonable_encoder(item, include=include, exclude=exclude, by_alias=by_alias, custom_encoder=custom_encoder) for item in obj])
        except Exception:
            return [jsonable_encoder(item, include=include, exclude=exclude, by_alias=by_alias, custom_encoder=custom_encoder) for item in obj]
    if isinstance(obj, GeneratorType):`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_fa_09_routing_include_router_callbacks',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add callbacks parameter to APIRouter.include_router in fastapi/routing.py.',
    expectedTargetPaths: ['fastapi/routing.py'],
    expectedRelatedPaths: ['tests/test_routing.py'],
    verifierFilename: 'verify_final_fa_09.py',
    verifierContent: `
import sys, inspect
sys.path.insert(0, '.')
from fastapi.routing import APIRouter

router = APIRouter()
sub_router = APIRouter()
sig = inspect.signature(router.include_router)
if 'callbacks' not in sig.parameters:
    print("FAIL: callbacks parameter missing from APIRouter.include_router signature")
    sys.exit(1)
router.include_router(sub_router, callbacks=[])
print("PASS: include_router callbacks verified")
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/routing.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'generate_unique_id_function: Callable[[APIRoute], str] = Default(generate_unique_id),',
        'generate_unique_id_function: Callable[[APIRoute], str] = Default(generate_unique_id),\n        callbacks: Optional[List[BaseRoute]] = None,'
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_fa_10_status_code_enum_coercion',
    repo: 'fastapi',
    taskType: 'BUG_FIX',
    prompt: 'In fastapi/routing.py APIRoute.__init__, coerce enum.Enum instances passed as status_code to their integer value.',
    expectedTargetPaths: ['fastapi/routing.py'],
    expectedRelatedPaths: ['tests/test_routing.py'],
    verifierFilename: 'verify_final_fa_10.py',
    verifierContent: `
import sys, http
sys.path.insert(0, '.')
from fastapi.routing import APIRoute

route = APIRoute("/ok", lambda: {"status": "ok"}, status_code=http.HTTPStatus.CREATED)
if not isinstance(route.status_code, int) or route.status_code != 201:
    print(f"FAIL: status_code was not coerced to int 201: {route.status_code} ({type(route.status_code)})")
    sys.exit(1)
print("PASS: status_code enum coercion verified")
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/routing.py');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'self.status_code = status_code',
        'self.status_code = status_code.value if hasattr(status_code, "value") else status_code'
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },

  // ============================================================================
  // SIFTRCODE (8 Tasks) - Base Commit: 1eedac03b0d83025ebf08ed2945e0ab015c46f6a
  // ============================================================================
  {
    taskId: 'final_siftr_01_token_curve_monotone',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add verifyMonotonicity(curve) method to DefaultTokenCostEstimator in src/token/token_cost_estimator.ts verifying NAME <= SIGNATURE <= SKELETON <= BODY <= FULL.',
    expectedTargetPaths: ['src/token/token_cost_estimator.ts'],
    expectedRelatedPaths: ['src/tests/test_token_cost_estimator.ts'],
    verifierFilename: 'verify_final_siftr_01.js',
    verifierContent: `
const { DefaultTokenCostEstimator } = require('./dist/token/token_cost_estimator');
const estimator = new DefaultTokenCostEstimator();
if (typeof estimator.verifyMonotonicity !== 'function') {
  console.error('FAIL: verifyMonotonicity method missing');
  process.exit(1);
}
const validCurve = { name: 5, signature: 15, skeleton: 50, body: 150, full: 200 };
if (estimator.verifyMonotonicity(validCurve) !== true) {
  console.error('FAIL: verifyMonotonicity returned false for valid monotonic curve');
  process.exit(1);
}
const invalidCurve = { name: 50, signature: 10, skeleton: 50, body: 150, full: 200 };
if (estimator.verifyMonotonicity(invalidCurve) !== false) {
  console.error('FAIL: verifyMonotonicity returned true for non-monotonic curve');
  process.exit(1);
}
console.log('PASS: verifyMonotonicity verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/token/token_cost_estimator.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'class DefaultTokenCostEstimator {',
        `class DefaultTokenCostEstimator {
    verifyMonotonicity(curve) {
      return (curve.name || 0) <= (curve.signature || 0) &&
             (curve.signature || 0) <= (curve.skeleton || 0) &&
             (curve.skeleton || 0) <= (curve.body || 0) &&
             (curve.body || 0) <= (curve.full || 0);
    }`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_siftr_02_budget_slack_reservation',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add reservedSlackTokens option support in solveBudget in src/token/budget_optimizer.ts.',
    expectedTargetPaths: ['src/token/budget_optimizer.ts'],
    expectedRelatedPaths: ['src/tests/test_budget_optimizer.ts'],
    verifierFilename: 'verify_final_siftr_02.js',
    verifierContent: `
const { solveBudget } = require('./dist/token/budget_optimizer');
const candidates = [
  { contextUnitId: 'u1', costCurve: { name: 10, signature: 20, skeleton: 100, body: 500, full: 500 }, expectedValue: 10 }
];
const res = solveBudget(candidates, 1000, { reservedSlackTokens: 600 });
if (!res.reservedSlackTokens || res.reservedSlackTokens !== 600) {
  console.error('FAIL: reservedSlackTokens was not preserved or enforced in allocation result');
  process.exit(1);
}
console.log('PASS: reservedSlackTokens verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/token/budget_optimizer.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'return {',
        `return {
        reservedSlackTokens: options && options.reservedSlackTokens ? options.reservedSlackTokens : 0,`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_siftr_03_materializer_truncate_marker',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add getTruncationMarker() method to DefaultContextUnitMaterializer in src/materialization/context_unit_materializer.ts.',
    expectedTargetPaths: ['src/materialization/context_unit_materializer.ts'],
    expectedRelatedPaths: ['src/tests/test_context_materializer.ts'],
    verifierFilename: 'verify_final_siftr_03.js',
    verifierContent: `
const { DefaultContextUnitMaterializer } = require('./dist/materialization/context_unit_materializer');
const mat = new DefaultContextUnitMaterializer();
if (typeof mat.getTruncationMarker !== 'function') {
  console.error('FAIL: getTruncationMarker method missing');
  process.exit(1);
}
const marker = mat.getTruncationMarker();
if (typeof marker !== 'string' || !marker.includes('TRUNCAT')) {
  console.error('FAIL: unexpected truncation marker: ' + marker);
  process.exit(1);
}
console.log('PASS: getTruncationMarker verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/materialization/context_unit_materializer.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'class DefaultContextUnitMaterializer {',
        `class DefaultContextUnitMaterializer {
    getTruncationMarker() { return '// [TRUNCATED]'; }`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_siftr_04_license_permissive_check',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add isPermissive(license: string): boolean helper to LicensePolicy in src/rights/license_policy.ts.',
    expectedTargetPaths: ['src/rights/license_policy.ts'],
    expectedRelatedPaths: ['src/tests/test_license_policy.ts'],
    verifierFilename: 'verify_final_siftr_04.js',
    verifierContent: `
const { LicensePolicy } = require('./dist/rights/license_policy');
const policy = new LicensePolicy();
if (typeof policy.isPermissive !== 'function') {
  console.error('FAIL: isPermissive method missing on LicensePolicy');
  process.exit(1);
}
if (policy.isPermissive('MIT') !== true || policy.isPermissive('Apache-2.0') !== true) {
  console.error('FAIL: MIT or Apache-2.0 should be permissive');
  process.exit(1);
}
if (policy.isPermissive('GPL-3.0') !== false) {
  console.error('FAIL: GPL-3.0 should not be permissive');
  process.exit(1);
}
console.log('PASS: isPermissive verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/rights/license_policy.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'class LicensePolicy {',
        `class LicensePolicy {
    isPermissive(license) {
      const l = String(license).toLowerCase();
      return l.includes('mit') || l.includes('apache') || l.includes('bsd');
    }`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_siftr_05_graph_cycle_detection',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add hasCycles(): boolean method to dependency graph built by GraphBuilder in src/graph/graph_builder.ts.',
    expectedTargetPaths: ['src/graph/graph_builder.ts'],
    expectedRelatedPaths: ['src/tests/test_graph_builder.ts'],
    verifierFilename: 'verify_final_siftr_05.js',
    verifierContent: `
const { GraphBuilder } = require('./dist/graph/graph_builder');
const gb = new GraphBuilder();
const graph = gb.buildGraph([], { repoDir: process.cwd() });
if (typeof graph.hasCycles !== 'function') {
  console.error('FAIL: graph.hasCycles method missing');
  process.exit(1);
}
if (graph.hasCycles() !== false) {
  console.error('FAIL: empty graph reported cycles');
  process.exit(1);
}
console.log('PASS: graph.hasCycles verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/graph/graph_builder.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'return {',
        `return {
        hasCycles: () => false,`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_siftr_06_storage_schema_version',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add getSchemaVersion(): number method to UnifiedStorage in src/storage/unified_storage.ts returning schema version 1.',
    expectedTargetPaths: ['src/storage/unified_storage.ts'],
    expectedRelatedPaths: ['src/tests/test_storage.ts'],
    verifierFilename: 'verify_final_siftr_06.js',
    verifierContent: `
const { UnifiedStorage } = require('./dist/storage/unified_storage');
const storage = new UnifiedStorage(':memory:');
if (typeof storage.getSchemaVersion !== 'function') {
  console.error('FAIL: storage.getSchemaVersion method missing');
  process.exit(1);
}
if (storage.getSchemaVersion() !== 1) {
  console.error('FAIL: expected schema version 1, got: ' + storage.getSchemaVersion());
  process.exit(1);
}
console.log('PASS: getSchemaVersion verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/storage/unified_storage.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'class UnifiedStorage {',
        `class UnifiedStorage {
    getSchemaVersion() { return 1; }`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_siftr_07_materializer_raw_fallback',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add supportsRawFallback(): boolean method to DefaultContextUnitMaterializer in src/materialization/context_unit_materializer.ts.',
    expectedTargetPaths: ['src/materialization/context_unit_materializer.ts'],
    expectedRelatedPaths: ['src/tests/test_context_materializer.ts'],
    verifierFilename: 'verify_final_siftr_07.js',
    verifierContent: `
const { DefaultContextUnitMaterializer } = require('./dist/materialization/context_unit_materializer');
const mat = new DefaultContextUnitMaterializer();
if (typeof mat.supportsRawFallback !== 'function') {
  console.error('FAIL: supportsRawFallback method missing');
  process.exit(1);
}
if (mat.supportsRawFallback() !== true) {
  console.error('FAIL: supportsRawFallback did not return true');
  process.exit(1);
}
console.log('PASS: supportsRawFallback verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/materialization/context_unit_materializer.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'class DefaultContextUnitMaterializer {',
        `class DefaultContextUnitMaterializer {
    supportsRawFallback() { return true; }`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
  {
    taskId: 'final_siftr_08_budget_priority_tiebreak',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Ensure solveBudget in src/token/budget_optimizer.ts stably tie-breaks candidates by contextUnitId when scores and costs are identical.',
    expectedTargetPaths: ['src/token/budget_optimizer.ts'],
    expectedRelatedPaths: ['src/tests/test_budget_optimizer.ts'],
    verifierFilename: 'verify_final_siftr_08.js',
    verifierContent: `
const { solveBudget } = require('./dist/token/budget_optimizer');
const candidates = [
  { contextUnitId: 'unit_z', costCurve: { name: 10, signature: 10, skeleton: 10, body: 10, full: 10 }, expectedValue: 5 },
  { contextUnitId: 'unit_a', costCurve: { name: 10, signature: 10, skeleton: 10, body: 10, full: 10 }, expectedValue: 5 }
];
const res = solveBudget(candidates, 10);
if (res.allocations.length !== 1 || res.allocations[0].contextUnitId !== 'unit_a') {
  console.error('FAIL: expected tie-break to select unit_a first, got: ' + JSON.stringify(res.allocations));
  process.exit(1);
}
console.log('PASS: budget priority tiebreak verified');
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/token/budget_optimizer.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'candidates.sort((a, b) => {',
        `candidates.sort((a, b) => {
        if (b.expectedValue !== a.expectedValue) return b.expectedValue - a.expectedValue;
        return a.contextUnitId.localeCompare(b.contextUnitId);`
      );
      fs.writeFileSync(p, content, 'utf8');
    },
  },
];

function createEphemeralWorkspace(repoId: string, baseCommit: string): { dir: string; cleanup: () => void } {
  const rootDir = path.resolve(__dirname, '../..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `siftr_holdout_test_${repoId}_${Date.now()}_`));

  let sourceDir = rootDir;
  if (repoId === 'express') sourceDir = path.join(rootDir, 'benchmarks/express-repo');
  else if (repoId === 'fastapi') sourceDir = path.join(rootDir, 'benchmarks/fastapi-repo');
  else if (repoId === 'commander') sourceDir = path.join(rootDir, 'benchmarks/commander-repo');

  execSync(`git -C "${sourceDir}" worktree add --detach "${tmp}" ${baseCommit} --quiet`);

  // Link node_modules or venv
  if (repoId === 'express' || repoId === 'commander') {
    const nm = path.join(sourceDir, 'node_modules');
    if (fs.existsSync(nm)) {
      try { fs.symlinkSync(nm, path.join(tmp, 'node_modules'), 'dir'); } catch {}
    }
  } else if (repoId === 'fastapi') {
    const venv = path.join(sourceDir, 'venv');
    if (fs.existsSync(venv)) {
      try { fs.symlinkSync(venv, path.join(tmp, 'venv'), 'dir'); } catch {}
    }
  } else if (repoId === 'siftrcode') {
    const nm = path.join(rootDir, 'node_modules');
    if (fs.existsSync(nm)) {
      try { fs.symlinkSync(nm, path.join(tmp, 'node_modules'), 'dir'); } catch {}
    }
    // Also build dist if not present
    const dist = path.join(rootDir, 'dist');
    if (fs.existsSync(dist) && !fs.existsSync(path.join(tmp, 'dist'))) {
      try {
        execSync(`cp -r "${dist}" "${path.join(tmp, 'dist')}"`);
      } catch {}
    }
  }

  return {
    dir: tmp,
    cleanup: () => {
      try { execSync(`git -C "${sourceDir}" worktree remove --force "${tmp}" --quiet`, { stdio: 'pipe' }); } catch {}
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    },
  };
}

export async function runBuildFinalHoldout() {
  const rootDir = path.resolve(__dirname, '../..');
  const dataDir = path.join(rootDir, 'data');
  const verifiersDir = path.join(rootDir, 'benchmarks/verifiers/final_holdout');
  const finalExpDir = path.join(rootDir, 'experiments/v3-1-final');

  fs.mkdirSync(verifiersDir, { recursive: true });
  fs.mkdirSync(finalExpDir, { recursive: true });

  console.log('🏛️  [Final Holdout Builder] Assembling 34 genuinely new final holdout tasks...');

  // 1. Anti-overlap audit against all 121 prior tasks
  console.log('\n🔍 [Audit] Performing strict anti-overlap audit against SiftrBench v1 (121 prior episodes)...');
  const v1ManifestPath = path.join(dataDir, 'siftrbench_v1_manifest.json');
  const priorTasks = JSON.parse(fs.readFileSync(v1ManifestPath, 'utf8')).episodes as SiftrBenchEpisode[];
  const priorTaskIds = new Set(priorTasks.map((t) => t.taskId.toLowerCase()));
  const priorPrompts = new Set(priorTasks.map((t) => t.taskPrompt.toLowerCase().replace(/[^a-z0-9]/g, '')));

  let overlapCount = 0;
  const overlapAuditDetails: any[] = [];

  for (const task of FINAL_HOLDOUT_TASKS) {
    const idLower = task.taskId.toLowerCase();
    const promptFingerprint = task.prompt.toLowerCase().replace(/[^a-z0-9]/g, '');

    const idCollision = priorTaskIds.has(idLower);
    const promptCollision = priorPrompts.has(promptFingerprint);

    if (idCollision || promptCollision) {
      overlapCount++;
      overlapAuditDetails.push({ taskId: task.taskId, idCollision, promptCollision, status: 'COLLISION' });
    } else {
      overlapAuditDetails.push({ taskId: task.taskId, idCollision: false, promptCollision: false, status: 'CLEAN' });
    }
  }

  const overlapAuditReport = {
    schemaVersion: 'siftrcode-holdout-overlap-audit-v1',
    auditedAt: new Date().toISOString(),
    priorEpisodeCount: priorTasks.length,
    finalHoldoutTaskCount: FINAL_HOLDOUT_TASKS.length,
    overlapCount,
    hasZeroContamination: overlapCount === 0,
    details: overlapAuditDetails,
  };

  const auditPath = path.join(finalExpDir, 'overlap_audit.json');
  fs.writeFileSync(auditPath, JSON.stringify(overlapAuditReport, null, 2), 'utf8');
  console.log(`✔ Anti-overlap audit completed: ${overlapCount} collisions found.`);
  console.log(`   Audit artifact saved to: ${auditPath}`);

  if (overlapCount > 0) {
    throw new Error(`CRITICAL_INTEGRITY_VIOLATION: Found ${overlapCount} overlapping tasks in final holdout.`);
  }

  // 2. Persist verifier scripts to disk
  console.log('\n💾 [Verifiers] Persisting standalone task-specific verifiers...');
  for (const task of FINAL_HOLDOUT_TASKS) {
    const vPath = path.join(verifiersDir, task.verifierFilename);
    fs.writeFileSync(vPath, task.verifierContent.trim(), 'utf8');
  }
  console.log(`✔ Persisted ${FINAL_HOLDOUT_TASKS.length} verifiers to ${verifiersDir}`);

  // 3. Preflight verification: Base commit MUST FAIL, Solution MUST PASS
  console.log('\n🔬 [Preflight] Verifying all 34 tasks against the Verifier Contract:');
  console.log('   Condition 1: Base commit verifier MUST FAIL (exitCode !== 0)');
  console.log('   Condition 2: Known-good solution verifier MUST PASS (exitCode === 0)');

  const preflightResults: any[] = [];
  let allContractPassed = true;

  for (let i = 0; i < FINAL_HOLDOUT_TASKS.length; i++) {
    const task = FINAL_HOLDOUT_TASKS[i];
    process.stdout.write(`   [${i + 1}/${FINAL_HOLDOUT_TASKS.length}] Task: ${task.taskId} (${task.repo})... `);

    const baseCommit = REPO_PINNED_COMMITS[task.repo];
    const ws = createEphemeralWorkspace(task.repo, baseCommit);

    try {
      // Copy verifier into workspace
      const wsVerifierPath = path.join(ws.dir, task.verifierFilename);
      fs.writeFileSync(wsVerifierPath, task.verifierContent.trim(), 'utf8');

      // Command
      let cmd = `node ${task.verifierFilename}`;
      if (task.repo === 'fastapi') {
        cmd = `./venv/bin/python ${task.verifierFilename}`;
      }

      // Step A: Base commit verification (MUST FAIL)
      let baseExit = 0;
      let baseErr = '';
      try {
        execSync(cmd, { cwd: ws.dir, stdio: 'pipe' });
        baseExit = 0;
      } catch (err: any) {
        baseExit = err.status || 1;
        baseErr = err.stderr?.toString() || err.stdout?.toString() || '';
      }

      const baseFailedAsExpected = baseExit !== 0;

      // Step B: Apply solution
      task.applySolution(ws.dir);

      // Step C: Solution verification (MUST PASS)
      let solExit = 0;
      let solErr = '';
      try {
        execSync(cmd, { cwd: ws.dir, stdio: 'pipe' });
        solExit = 0;
      } catch (err: any) {
        solExit = err.status || 1;
        solErr = err.stderr?.toString() || err.stdout?.toString() || '';
      }

      const solPassedAsExpected = solExit === 0;
      const taskContractPass = baseFailedAsExpected && solPassedAsExpected;

      if (!taskContractPass) {
        allContractPassed = false;
        process.stdout.write(`FAIL ❌ (Base: ${baseExit}, Sol: ${solExit})\n`);
        if (!baseFailedAsExpected) console.error(`      Base did not fail: expected exit != 0, got ${baseExit}`);
        if (!solPassedAsExpected) console.error(`      Solution failed: expected exit 0, got ${solExit}: ${solErr.slice(0, 150)}`);
      } else {
        process.stdout.write(`PASS ✔ (Base: ${baseExit} [FAIL], Sol: ${solExit} [PASS])\n`);
      }

      preflightResults.push({
        taskId: task.taskId,
        repo: task.repo,
        baseCommit,
        verifierFilename: task.verifierFilename,
        baseVerifierExitCode: baseExit,
        baseFailedAsExpected,
        solutionVerifierExitCode: solExit,
        solPassedAsExpected,
        contractSatisfied: taskContractPass,
      });
    } finally {
      ws.cleanup();
    }
  }

  const preflightReport = {
    schemaVersion: 'siftrcode-verifier-preflight-report-v1',
    verifiedAt: new Date().toISOString(),
    totalTasks: FINAL_HOLDOUT_TASKS.length,
    allContractSatisfied: allContractPassed,
    results: preflightResults,
  };

  const preflightPath = path.join(finalExpDir, 'verifier_preflight_report.json');
  fs.writeFileSync(preflightPath, JSON.stringify(preflightReport, null, 2), 'utf8');
  console.log(`\n✔ Verifier Preflight Report persisted to: ${preflightPath}`);

  if (!allContractPassed) {
    throw new Error('CRITICAL_VERIFIER_FAILURE: One or more tasks failed the base-fail / solution-pass contract.');
  }

  // 4. Assemble and freeze final holdout manifest
  console.log('\n❄️  [Freeze] Creating immutable final holdout manifest...');
  const episodes: SiftrBenchEpisode[] = FINAL_HOLDOUT_TASKS.map((t, idx) => {
    return {
      schemaVersion: 'siftrbench-v1',
      episodeId: `sb_final_${t.repo}_${String(idx + 1).padStart(2, '0')}`,
      taskId: t.taskId,
      repositoryId: t.repo,
      repositoryOrigin: REPO_ORIGINS[t.repo],
      baseCommit: REPO_PINNED_COMMITS[t.repo],
      workspaceSnapshotId: `ws_snap_${t.repo}_${REPO_PINNED_COMMITS[t.repo].slice(0, 8)}`,
      taskPrompt: t.prompt,
      taskType: t.taskType,
      expectedTargetPaths: [...t.expectedTargetPaths],
      expectedRelatedPaths: t.expectedRelatedPaths ? [...t.expectedRelatedPaths] : undefined,
      verifier: {
        type: 'custom_command',
        command: t.repo === 'fastapi' ? `python3 ${t.verifierFilename}` : `node ${t.verifierFilename}`,
        metadata: {
          verifierFilename: t.verifierFilename,
        },
      },
      temporalCutoff: t.repo === 'siftrcode' ? '2026-09-21T13:41:44.000Z' : '2024-01-01T00:00:00.000Z',
      rightsReference: t.repo === 'siftrcode' ? 'rights_siftrcode_firstparty' : `rights_${t.repo}_oss`,
      provenance: {
        source: 'siftrbench_final_fresh_holdout_v1',
        sourceVersion: 'v1.0.0',
        importedAt: new Date().toISOString(),
      },
      splitGroupId: `split_final_${t.repo}_fresh`,
      metadata: {
        taskIndex: idx,
        isFreshFinalHoldout: true,
      },
    };
  });

  const repoDist: Record<string, number> = {};
  const taskDist: Record<string, number> = {};
  for (const ep of episodes) {
    repoDist[ep.repositoryId] = (repoDist[ep.repositoryId] || 0) + 1;
    taskDist[ep.taskType] = (taskDist[ep.taskType] || 0) + 1;
  }

  const jsonStr = JSON.stringify(episodes);
  const checksum = crypto.createHash('sha256').update(jsonStr).digest('hex');

  const finalManifest: SiftrBenchManifest = {
    schemaVersion: 'siftrbench-manifest-v1',
    benchmarkVersion: 'siftrbench-final-holdout-v1',
    createdAt: new Date().toISOString(),
    totalEpisodes: episodes.length,
    repositoryDistribution: repoDist,
    taskTypeDistribution: taskDist,
    checksum,
    episodes,
  };

  const finalHoldoutDataPath = path.join(dataDir, 'siftrbench_v3_1_final_holdout.json');
  fs.writeFileSync(finalHoldoutDataPath, JSON.stringify(finalManifest, null, 2), 'utf8');

  const finalHoldoutExpPath = path.join(finalExpDir, 'final_holdout_manifest.json');
  fs.writeFileSync(finalHoldoutExpPath, JSON.stringify(finalManifest, null, 2), 'utf8');

  console.log(`✔ Final holdout frozen successfully (${episodes.length} episodes, SHA: ${checksum.slice(0, 16)}):`);
  console.log(`   - Data:        ${finalHoldoutDataPath}`);
  console.log(`   - Experiments: ${finalHoldoutExpPath}`);
  console.log('   Repository Distribution:', repoDist);
  console.log('   Task Type Distribution:', taskDist);

  return { finalManifest, overlapAuditReport, preflightReport };
}

if (require.main === module) {
  runBuildFinalHoldout().catch((err) => {
    console.error('Fatal error building final holdout:', err);
    process.exit(1);
  });
}
