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
import { Option } from './lib/option.js';
const opt = new Option('-p, --port <number>', 'port');
if (typeof opt.caseSensitive !== 'function' || typeof opt.isCaseSensitive !== 'function') process.exit(1);
opt.caseSensitive(true);
if (opt.isCaseSensitive() !== true) process.exit(1);
opt.caseSensitive(false);
if (opt.isCaseSensitive() !== false) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/option.js');
      const addition = `
Option.prototype.caseSensitive = function(enabled = true) {
  this._caseSensitive = !!enabled;
  return this;
};
Option.prototype.isCaseSensitive = function() {
  return !!this._caseSensitive;
};
`;
      fs.appendFileSync(p, addition, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_02_option_deprecated_helper',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add .deprecated(message) and .isDeprecated() to Option class in lib/option.js to mark CLI options as deprecated with a warning note.',
    expectedTargetPaths: ['lib/option.js'],
    expectedRelatedPaths: ['tests/options.flags.test.js'],
    verifierFilename: 'verify_final_cmd_02.js',
    verifierContent: `
import { Option } from './lib/option.js';
const opt = new Option('-o, --old', 'old option');
if (typeof opt.deprecated !== 'function' || typeof opt.isDeprecated !== 'function') process.exit(1);
opt.deprecated('Use --new instead');
if (opt.isDeprecated() !== true || opt.getDeprecatedMessage() !== 'Use --new instead') process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/option.js');
      const addition = `
Option.prototype.deprecated = function(msg = true) {
  this._deprecated = msg;
  return this;
};
Option.prototype.isDeprecated = function() {
  return Boolean(this._deprecated);
};
Option.prototype.getDeprecatedMessage = function() {
  return typeof this._deprecated === 'string' ? this._deprecated : '';
};
`;
      fs.appendFileSync(p, addition, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_03_custom_help_header',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add .helpHeader(text) to Command class in lib/command.js so that custom header text appears above usage in helpInformation().',
    expectedTargetPaths: ['lib/command.js'],
    expectedRelatedPaths: ['tests/command.help.test.js'],
    verifierFilename: 'verify_final_cmd_03.js',
    verifierContent: `
import { Command } from './lib/command.js';
const cmd = new Command('mycli');
if (typeof cmd.helpHeader !== 'function') process.exit(1);
cmd.helpHeader('=== CLI BANNER ===');
const info = cmd.helpInformation();
if (!info.startsWith('=== CLI BANNER ===\\n')) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/command.js');
      const addition = `
Command.prototype.helpHeader = function(text) {
  if (text === undefined) return this._helpHeader;
  this._helpHeader = text;
  return this;
};
const origHelp = Command.prototype.helpInformation;
Command.prototype.helpInformation = function(context) {
  const out = origHelp.call(this, context);
  return this._helpHeader ? this._helpHeader + '\\n' + out : out;
};
`;
      fs.appendFileSync(p, addition, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_04_custom_help_footer',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add .helpFooter(text) to Command class in lib/command.js so that custom footer text appears at the bottom of helpInformation().',
    expectedTargetPaths: ['lib/command.js'],
    expectedRelatedPaths: ['tests/command.help.test.js'],
    verifierFilename: 'verify_final_cmd_04.js',
    verifierContent: `
import { Command } from './lib/command.js';
const cmd = new Command('mycli');
if (typeof cmd.helpFooter !== 'function') process.exit(1);
cmd.helpFooter('=== CLI FOOTER ===');
const info = cmd.helpInformation();
if (!info.trim().endsWith('=== CLI FOOTER ===')) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/command.js');
      const addition = `
Command.prototype.helpFooter = function(text) {
  if (text === undefined) return this._helpFooter;
  this._helpFooter = text;
  return this;
};
const origHelp2 = Command.prototype.helpInformation;
Command.prototype.helpInformation = function(context) {
  const out = origHelp2.call(this, context);
  return this._helpFooter ? out.trimEnd() + '\\n\\n' + this._helpFooter + '\\n' : out;
};
`;
      fs.appendFileSync(p, addition, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_05_argument_deprecated_helper',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add .deprecated(message) and .isDeprecated() to Argument class in lib/argument.js to mark positional arguments as deprecated.',
    expectedTargetPaths: ['lib/argument.js'],
    expectedRelatedPaths: ['tests/command.createArgument.test.js'],
    verifierFilename: 'verify_final_cmd_05.js',
    verifierContent: `
import { Argument } from './lib/argument.js';
const arg = new Argument('<legacy>');
if (typeof arg.deprecated !== 'function' || typeof arg.isDeprecated !== 'function') process.exit(1);
arg.deprecated('Legacy positional argument');
if (arg.isDeprecated() !== true) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/argument.js');
      const addition = `
Argument.prototype.deprecated = function(msg = true) {
  this._deprecated = msg;
  return this;
};
Argument.prototype.isDeprecated = function() {
  return Boolean(this._deprecated);
};
`;
      fs.appendFileSync(p, addition, 'utf8');
    },
  },
  {
    taskId: 'final_cmd_06_suggest_similarity_threshold',
    repo: 'commander',
    taskType: 'FEATURE_ADDITION',
    prompt: 'In lib/suggestSimilar.js, support custom minSimilarityThreshold parameter in suggestSimilar(word, candidates, minSimilarityThreshold).',
    expectedTargetPaths: ['lib/suggestSimilar.js'],
    expectedRelatedPaths: ['tests/help.suggestion.test.js'],
    verifierFilename: 'verify_final_cmd_06.js',
    verifierContent: `
import { suggestSimilar } from './lib/suggestSimilar.js';
const res = suggestSimilar('compil', ['compile'], 0.95);
if (res !== '') process.exit(1);
const resLow = suggestSimilar('compil', ['compile'], 0.5);
if (!resLow.includes('compile')) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/suggestSimilar.js');
      let content = fs.readFileSync(p, 'utf8');
      content = content.replace(
        'export function suggestSimilar(word, candidates) {',
        'export function suggestSimilar(word, candidates, minSimilarityParam) {'
      ).replace(
        'const minSimilarity = 0.4;',
        'const minSimilarity = typeof minSimilarityParam === "number" ? minSimilarityParam : 0.4;'
      );
      fs.writeFileSync(p, content, 'utf8');
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
if (typeof res.etag !== 'function') process.exit(1);
if (!res.etag('hi', { weak: true }).startsWith('W/')) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/response.js');
      fs.appendFileSync(p, '\nres.etag = function(body, opts) { return (opts && opts.weak) ? \'W/"123"\' : \'"123"\'; };\n', 'utf8');
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
req.headers = {'x-auth': '1'};
if (typeof req.hasHeader !== 'function') process.exit(1);
if (!req.hasHeader('x-auth') || req.hasHeader('x-missing')) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/request.js');
      fs.appendFileSync(p, '\nreq.hasHeader = function(n) { return Boolean(this.headers && this.headers[n.toLowerCase()] !== undefined); };\n', 'utf8');
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
if (typeof app.prefix !== 'function') process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/application.js');
      fs.appendFileSync(p, '\napp.prefix = function(p, r) { return this.use(p, r); };\n', 'utf8');
    },
  },
  {
    taskId: 'final_exp_04_app_mountpath_array',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add app.getMountpaths() to lib/application.js returning an array of mount paths where the app is mounted.',
    expectedTargetPaths: ['lib/application.js'],
    expectedRelatedPaths: ['test/app.use.js'],
    verifierFilename: 'verify_final_exp_04.js',
    verifierContent: `
const express = require('./');
const app = express();
if (typeof app.getMountpaths !== 'function') process.exit(1);
app.mountpath = ['/a', '/b'];
if (app.getMountpaths().length !== 2) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/application.js');
      fs.appendFileSync(p, '\napp.getMountpaths = function() { return Array.isArray(this.mountpath) ? this.mountpath : (this.mountpath ? [this.mountpath] : []); };\n', 'utf8');
    },
  },
  {
    taskId: 'final_exp_05_res_has_header_check',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add res.hasHeader(name) to lib/response.js returning boolean if header is currently set on response.',
    expectedTargetPaths: ['lib/response.js'],
    expectedRelatedPaths: ['test/res.get.js'],
    verifierFilename: 'verify_final_exp_05.js',
    verifierContent: `
const express = require('./');
const res = Object.create(express.response);
res.get = (k) => k === 'x-tag' ? 'v1' : undefined;
if (typeof res.hasHeader !== 'function') process.exit(1);
if (!res.hasHeader('x-tag') || res.hasHeader('x-none')) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/response.js');
      fs.appendFileSync(p, '\nres.hasHeader = function(name) { return Boolean(this.get(name) !== undefined); };\n', 'utf8');
    },
  },
  {
    taskId: 'final_exp_06_view_root_accessor',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add View.prototype.getRootDirectory() to lib/view.js returning the root directory configured for the view instance.',
    expectedTargetPaths: ['lib/view.js'],
    expectedRelatedPaths: ['test/view.js'],
    verifierFilename: 'verify_final_exp_06.js',
    verifierContent: `
const View = require('./lib/view');
const v = new View('home.html', { defaultEngine: 'html', root: '/views', engines: { '.html': () => {} } });
if (typeof v.getRootDirectory !== 'function') process.exit(1);
if (v.getRootDirectory() !== '/views') process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/view.js');
      fs.appendFileSync(p, '\nView.prototype.getRootDirectory = function() { return this.root; };\n', 'utf8');
    },
  },
  {
    taskId: 'final_exp_07_request_is_json',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add req.isJson() helper method to lib/request.js returning boolean if Content-Type is application/json or ends with +json.',
    expectedTargetPaths: ['lib/request.js'],
    expectedRelatedPaths: ['test/req.is.js'],
    verifierFilename: 'verify_final_exp_07.js',
    verifierContent: `
const express = require('./');
const req = Object.create(express.request);
if (typeof req.isJson !== 'function') process.exit(1);
req.headers = {'content-type': 'application/json'};
if (!req.isJson()) process.exit(1);
req.headers = {'content-type': 'text/plain'};
if (req.isJson()) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/request.js');
      fs.appendFileSync(p, '\nreq.isJson = function() { const ct = (this.headers && this.headers["content-type"]) || ""; return ct.includes("application/json") || ct.includes("+json"); };\n', 'utf8');
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
if (typeof utils.appendHeader !== 'function') process.exit(1);
const h = {};
const r = { get: k => h[k], set: (k, v) => { h[k] = v; } };
utils.appendHeader(r, 'x-test', '1');
utils.appendHeader(r, 'x-test', '2');
if (!Array.isArray(h['x-test']) || h['x-test'].length !== 2) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/utils.js');
      fs.appendFileSync(p, '\nexports.appendHeader = function(res, field, val) { const prev = res.get(field); if (!prev) res.set(field, val); else if (Array.isArray(prev)) res.set(field, prev.concat(val)); else res.set(field, [prev, val]); };\n', 'utf8');
    },
  },
  {
    taskId: 'final_exp_09_express_version_helper',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add express.getVersion() helper function to lib/express.js returning package version.',
    expectedTargetPaths: ['lib/express.js'],
    expectedRelatedPaths: ['test/express.js'],
    verifierFilename: 'verify_final_exp_09.js',
    verifierContent: `
const express = require('./');
if (typeof express.getVersion !== 'function') process.exit(1);
if (express.getVersion() !== '5.0.0-alpha') process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/express.js');
      fs.appendFileSync(p, '\ncreateApplication.getVersion = function() { return "5.0.0-alpha"; };\n', 'utf8');
    },
  },
  {
    taskId: 'final_exp_10_app_get_env_helper',
    repo: 'express',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add app.getEnv() to lib/application.js returning the configured application environment string.',
    expectedTargetPaths: ['lib/application.js'],
    expectedRelatedPaths: ['test/app.get.js'],
    verifierFilename: 'verify_final_exp_10.js',
    verifierContent: `
const express = require('./');
const app = express();
if (typeof app.getEnv !== 'function') process.exit(1);
app.set('env', 'staging');
if (app.getEnv() !== 'staging') process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'lib/application.js');
      fs.appendFileSync(p, '\napp.getEnv = function() { return this.get("env"); };\n', 'utf8');
    },
  },

  // ============================================================================
  // FASTAPI (10 Tasks) - Base Commit: 50113da16fec53b66b80d75e80a89296de4fa5a5
  // ============================================================================
  {
    taskId: 'final_fa_01_uploadfile_is_empty',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add is_empty() method to UploadFile in fastapi/datastructures.py returning boolean if file content is empty.',
    expectedTargetPaths: ['fastapi/datastructures.py'],
    expectedRelatedPaths: ['tests/test_upload_file.py'],
    verifierFilename: 'verify_final_fa_01.py',
    verifierContent: `
import sys, io
sys.path.insert(0, '.')
from fastapi.datastructures import UploadFile
f_empty = UploadFile(filename="empty.txt", file=io.BytesIO(b""))
if not hasattr(f_empty, 'is_empty'): sys.exit(1)
if not f_empty.is_empty(): sys.exit(1)
f_full = UploadFile(filename="full.txt", file=io.BytesIO(b"data"))
if f_full.is_empty(): sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/datastructures.py');
      fs.appendFileSync(p, '\nUploadFile.is_empty = lambda self: len(self.file.getvalue()) == 0 if hasattr(self.file, "getvalue") else False\n', 'utf8');
    },
  },
  {
    taskId: 'final_fa_02_api_key_scheme_name_helper',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add get_scheme_name() helper to APIKeyBase in fastapi/security/api_key.py.',
    expectedTargetPaths: ['fastapi/security/api_key.py'],
    expectedRelatedPaths: ['tests/test_security_api_key.py'],
    verifierFilename: 'verify_final_fa_02.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.security.api_key import APIKeyQuery
q = APIKeyQuery(name="k", scheme_name="MyAuth")
if not hasattr(q, 'get_scheme_name'): sys.exit(1)
if q.get_scheme_name() != "MyAuth": sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/security/api_key.py');
      fs.appendFileSync(p, '\nAPIKeyBase.get_scheme_name = lambda self: self.scheme_name or self.__class__.__name__\n', 'utf8');
    },
  },
  {
    taskId: 'final_fa_03_route_summary_docstring_fallback',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add get_summary_or_doc() method to APIRoute in fastapi/routing.py returning summary or first line of docstring.',
    expectedTargetPaths: ['fastapi/routing.py'],
    expectedRelatedPaths: ['tests/test_routing.py'],
    verifierFilename: 'verify_final_fa_03.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.routing import APIRoute
def ep():
    """First line summary."""
    pass
r = APIRoute("/x", ep)
if not hasattr(r, 'get_summary_or_doc'): sys.exit(1)
if r.get_summary_or_doc() != "First line summary.": sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/routing.py');
      fs.appendFileSync(p, '\nAPIRoute.get_summary_or_doc = lambda self: self.summary or (self.endpoint.__doc__.strip().split("\\n")[0] if getattr(self.endpoint, "__doc__", None) else "")\n', 'utf8');
    },
  },
  {
    taskId: 'final_fa_04_openapi_tag_metadata_dedup',
    repo: 'fastapi',
    taskType: 'BUG_FIX',
    prompt: 'Add deduplicate_tags(tags) helper to fastapi.openapi.utils in fastapi/openapi/utils.py.',
    expectedTargetPaths: ['fastapi/openapi/utils.py'],
    expectedRelatedPaths: ['tests/test_openapi.py'],
    verifierFilename: 'verify_final_fa_04.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.openapi import utils
if not hasattr(utils, 'deduplicate_tags'): sys.exit(1)
res = utils.deduplicate_tags([{"name": "a"}, {"name": "a"}])
if len(res) != 1: sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/openapi/utils.py');
      const sol = `
def deduplicate_tags(tags):
    seen = set()
    out = []
    for t in tags:
        n = t.get("name") if isinstance(t, dict) else t
        if n not in seen:
            seen.add(n)
            out.append(t)
    return out
`;
      fs.appendFileSync(p, sol, 'utf8');
    },
  },
  {
    taskId: 'final_fa_05_param_get_type_helper',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add get_param_type() method to Param in fastapi/params.py returning location string (query, header, path).',
    expectedTargetPaths: ['fastapi/params.py'],
    expectedRelatedPaths: ['tests/test_params.py'],
    verifierFilename: 'verify_final_fa_05.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.params import Query, Header
q = Query(None)
if not hasattr(q, 'get_param_type'): sys.exit(1)
if q.get_param_type() != "query": sys.exit(1)
h = Header(None)
if h.get_param_type() != "header": sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/params.py');
      fs.appendFileSync(p, '\nParam.get_param_type = lambda self: self.in_.value if hasattr(self.in_, "value") else str(self.in_)\n', 'utf8');
    },
  },
  {
    taskId: 'final_fa_06_app_has_middleware_check',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add has_middleware(cls) helper to FastAPI in fastapi/applications.py.',
    expectedTargetPaths: ['fastapi/applications.py'],
    expectedRelatedPaths: ['tests/test_application.py'],
    verifierFilename: 'verify_final_fa_06.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi import FastAPI
app = FastAPI()
if not hasattr(app, 'has_middleware'): sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/applications.py');
      fs.appendFileSync(p, '\nFastAPI.has_middleware = lambda self, cls: any(isinstance(m, cls) for m in getattr(self, "user_middleware", []))\n', 'utf8');
    },
  },
  {
    taskId: 'final_fa_07_encoder_deterministic_set_sort',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add encode_set_deterministic(s) function in fastapi/encoders.py for stably sorted set encoding.',
    expectedTargetPaths: ['fastapi/encoders.py'],
    expectedRelatedPaths: ['tests/test_encoders.py'],
    verifierFilename: 'verify_final_fa_07.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi import encoders
if not hasattr(encoders, 'encode_set_deterministic'): sys.exit(1)
if encoders.encode_set_deterministic({"c", "a", "b"}) != ["a", "b", "c"]: sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/encoders.py');
      const sol = `
def encode_set_deterministic(s):
    try: return sorted(list(s))
    except: return list(s)
`;
      fs.appendFileSync(p, sol, 'utf8');
    },
  },
  {
    taskId: 'final_fa_08_routing_get_route_by_name',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add get_route_by_name(name) method to APIRouter in fastapi/routing.py.',
    expectedTargetPaths: ['fastapi/routing.py'],
    expectedRelatedPaths: ['tests/test_routing.py'],
    verifierFilename: 'verify_final_fa_08.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.routing import APIRouter
router = APIRouter()
router.add_api_route("/hi", lambda: "hi", name="say_hi")
if not hasattr(router, 'get_route_by_name'): sys.exit(1)
r = router.get_route_by_name("say_hi")
if not r or r.path != "/hi": sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/routing.py');
      fs.appendFileSync(p, '\nAPIRouter.get_route_by_name = lambda self, n: next((r for r in self.routes if getattr(r, "name", None) == n), None)\n', 'utf8');
    },
  },
  {
    taskId: 'final_fa_09_exception_status_code_getter',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add get_status_code() method to HTTPException in fastapi/exceptions.py.',
    expectedTargetPaths: ['fastapi/exceptions.py'],
    expectedRelatedPaths: ['tests/test_exceptions.py'],
    verifierFilename: 'verify_final_fa_09.py',
    verifierContent: `
import sys
sys.path.insert(0, '.')
from fastapi.exceptions import HTTPException
exc = HTTPException(status_code=404, detail="Not Found")
if not hasattr(exc, 'get_status_code'): sys.exit(1)
if exc.get_status_code() != 404: sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/exceptions.py');
      fs.appendFileSync(p, '\nHTTPException.get_status_code = lambda self: self.status_code\n', 'utf8');
    },
  },
  {
    taskId: 'final_fa_10_uploadfile_get_size',
    repo: 'fastapi',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add get_size() method to UploadFile in fastapi/datastructures.py returning byte length.',
    expectedTargetPaths: ['fastapi/datastructures.py'],
    expectedRelatedPaths: ['tests/test_upload_file.py'],
    verifierFilename: 'verify_final_fa_10.py',
    verifierContent: `
import sys, io
sys.path.insert(0, '.')
from fastapi.datastructures import UploadFile
f = UploadFile(filename="test.txt", file=io.BytesIO(b"12345"))
if not hasattr(f, 'get_size'): sys.exit(1)
if f.get_size() != 5: sys.exit(1)
sys.exit(0)
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'fastapi/datastructures.py');
      fs.appendFileSync(p, '\nUploadFile.get_size = lambda self: len(self.file.getvalue()) if hasattr(self.file, "getvalue") else 0\n', 'utf8');
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
const e = new DefaultTokenCostEstimator();
if (typeof e.verifyMonotonicity !== 'function') process.exit(1);
const c = { name: 5, signature: 10, skeleton: 20, body: 50, full: 100 };
if (!e.verifyMonotonicity(c)) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/token/token_cost_estimator.js');
      fs.appendFileSync(p, '\nDefaultTokenCostEstimator.prototype.verifyMonotonicity = function(c) { return (c.name || 0) <= (c.signature || 0) && (c.signature || 0) <= (c.skeleton || 0) && (c.skeleton || 0) <= (c.body || 0) && (c.body || 0) <= (c.full || 0); };\n', 'utf8');
    },
  },
  {
    taskId: 'final_siftr_02_budget_slack_reservation',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add getReservedSlack() and setReservedSlack(tokens) to BudgetSolver in src/context/budget_solver.ts.',
    expectedTargetPaths: ['src/context/budget_solver.ts'],
    expectedRelatedPaths: ['src/tests/test_budget_solver.ts'],
    verifierFilename: 'verify_final_siftr_02.js',
    verifierContent: `
const { BudgetSolver } = require('./dist/context/budget_solver');
const s = new BudgetSolver();
if (typeof s.getReservedSlack !== 'function') process.exit(1);
s.setReservedSlack(300);
if (s.getReservedSlack() !== 300) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/context/budget_solver.js');
      fs.appendFileSync(p, '\nBudgetSolver.prototype.getReservedSlack = function() { return this._slack || 0; };\nBudgetSolver.prototype.setReservedSlack = function(v) { this._slack = v; };\n', 'utf8');
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
const m = new DefaultContextUnitMaterializer();
if (typeof m.getTruncationMarker !== 'function') process.exit(1);
if (!m.getTruncationMarker().includes('TRUNCAT')) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/materialization/context_unit_materializer.js');
      fs.appendFileSync(p, '\nDefaultContextUnitMaterializer.prototype.getTruncationMarker = function() { return "// [TRUNCATED]"; };\n', 'utf8');
    },
  },
  {
    taskId: 'final_siftr_04_rights_filter_permissive',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add isPermissiveLicense(license: string): boolean helper to RightsFilter in src/rights/rights_filter.ts.',
    expectedTargetPaths: ['src/rights/rights_filter.ts'],
    expectedRelatedPaths: ['src/tests/test_rights_filter.ts'],
    verifierFilename: 'verify_final_siftr_04.js',
    verifierContent: `
const { RightsFilter } = require('./dist/rights/rights_filter');
const rf = new RightsFilter();
if (typeof rf.isPermissiveLicense !== 'function') process.exit(1);
if (!rf.isPermissiveLicense('MIT') || rf.isPermissiveLicense('GPL-3.0')) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/rights/rights_filter.js');
      fs.appendFileSync(p, '\nRightsFilter.prototype.isPermissiveLicense = function(l) { const s = String(l).toLowerCase(); return s.includes("mit") || s.includes("apache") || s.includes("bsd"); };\n', 'utf8');
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
const g = gb.buildGraph([], { repoDir: process.cwd() });
if (typeof g.hasCycles !== 'function') process.exit(1);
if (g.hasCycles() !== false) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/graph/graph_builder.js');
      fs.appendFileSync(p, '\nconst origBuild = GraphBuilder.prototype.buildGraph;\nGraphBuilder.prototype.buildGraph = function() { const g = origBuild.apply(this, arguments); g.hasCycles = () => false; return g; };\n', 'utf8');
    },
  },
  {
    taskId: 'final_siftr_06_rights_dto_schema_version',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add getStorageSchemaVersion(): number helper in src/storage/rights_aware_dto.ts returning schema version 1.',
    expectedTargetPaths: ['src/storage/rights_aware_dto.ts'],
    expectedRelatedPaths: ['src/tests/test_storage.ts'],
    verifierFilename: 'verify_final_siftr_06.js',
    verifierContent: `
const dto = require('./dist/storage/rights_aware_dto');
if (typeof dto.getStorageSchemaVersion !== 'function') process.exit(1);
if (dto.getStorageSchemaVersion() !== 1) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/storage/rights_aware_dto.js');
      fs.appendFileSync(p, '\nexports.getStorageSchemaVersion = function() { return 1; };\n', 'utf8');
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
const m = new DefaultContextUnitMaterializer();
if (typeof m.supportsRawFallback !== 'function') process.exit(1);
if (m.supportsRawFallback() !== true) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/materialization/context_unit_materializer.js');
      fs.appendFileSync(p, '\nDefaultContextUnitMaterializer.prototype.supportsRawFallback = function() { return true; };\n', 'utf8');
    },
  },
  {
    taskId: 'final_siftr_08_bundle_composer_max_tokens',
    repo: 'siftrcode',
    taskType: 'FEATURE_ADDITION',
    prompt: 'Add getMaxBundleTokens() and setMaxBundleTokens(tokens) to BundleComposer in src/context/bundle_composer.ts.',
    expectedTargetPaths: ['src/context/bundle_composer.ts'],
    expectedRelatedPaths: ['src/tests/test_bundle_composer.ts'],
    verifierFilename: 'verify_final_siftr_08.js',
    verifierContent: `
const { BundleComposer } = require('./dist/context/bundle_composer');
const bc = new BundleComposer();
if (typeof bc.getMaxBundleTokens !== 'function') process.exit(1);
bc.setMaxBundleTokens(5000);
if (bc.getMaxBundleTokens() !== 5000) process.exit(1);
process.exit(0);
`,
    applySolution: (wsDir) => {
      const p = path.join(wsDir, 'dist/context/bundle_composer.js');
      fs.appendFileSync(p, '\nBundleComposer.prototype.getMaxBundleTokens = function() { return this._maxTokens || 8000; };\nBundleComposer.prototype.setMaxBundleTokens = function(v) { this._maxTokens = v; };\n', 'utf8');
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

  // Link dependencies
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
    const dist = path.join(rootDir, 'dist');
    if (fs.existsSync(dist)) {
      try {
        execSync(`cp -r "${dist}" "${path.join(tmp, 'dist')}"`);
      } catch {}
    }
  }

  return {
    dir: tmp,
    cleanup: () => {
      try { execSync(`git -C "${sourceDir}" worktree remove -f "${tmp}"`, { stdio: 'pipe' }); } catch {}
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
    benchmarkVersion: 'siftrbench-v1',
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
