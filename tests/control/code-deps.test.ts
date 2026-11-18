import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { measureCodeDeps } from '../../packages/control/dist/code-deps.js';

const READ_LIMIT = 256 * 1024;
const bases: string[] = [];
afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

function measure(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'code-deps-'));
  bases.push(root);
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
  return measureCodeDeps(root, Object.keys(files), READ_LIMIT);
}

describe('TypeScript and JavaScript imports', () => {
  const entry = 'packages/app/src/main.ts';
  const repo = {
    'tsconfig.base.json': JSON.stringify({
      compilerOptions: { paths: { '@shared/*': ['shared/*'] } },
    }),
    'shared/strings.ts': 'export const s = 1;\n',
    'packages/lib/package.json': JSON.stringify({ name: '@acme/lib' }),
    'packages/lib/src/index.ts': 'export const lib = 1;\n',
    'packages/lib/src/util/format.ts': 'export const format = 1;\n',
    'packages/app/package.json': JSON.stringify({
      name: '@acme/app',
      dependencies: { '@acme/lib': 'workspace:*', zod: '3.0.0' },
    }),
    'packages/app/tsconfig.json':
      '{\n  // Shared aliases\n  "extends": "../../tsconfig.base",\n}\n',
    'packages/app/src/a.ts': 'export const a = 1;\n',
    'packages/app/src/side.ts': 'console.log(1);\n',
    'packages/app/src/legacy.cjs': 'module.exports = 1;\n',
    'packages/app/src/dir/index.ts': 'export const d = 1;\n',
    'packages/app/src/hidden.ts': 'export const h = 1;\n',
  };
  it.each([
    {
      form: 'import from with .js for .ts',
      source: "import { a } from './a.js';",
      to: 'packages/app/src/a.ts',
    },
    { form: 'import type', source: "import type { A } from './a';", to: 'packages/app/src/a.ts' },
    {
      form: 'multi-line import',
      source: "\n\nimport {\n  a,\n  b,\n} from './a';",
      to: 'packages/app/src/a.ts',
      line: 3,
    },
    { form: 'export star from', source: "export * from './a.js';", to: 'packages/app/src/a.ts' },
    {
      form: 'export names from',
      source: "export { a as b } from './a';",
      to: 'packages/app/src/a.ts',
    },
    { form: 'side-effect import', source: "import './side';", to: 'packages/app/src/side.ts' },
    {
      form: 'dynamic import',
      source: "const m = await import('./a.js');",
      to: 'packages/app/src/a.ts',
    },
    {
      form: 'require',
      source: "const r = require('./legacy.cjs');",
      to: 'packages/app/src/legacy.cjs',
    },
    {
      form: 'index file',
      source: "import { d } from './dir';",
      to: 'packages/app/src/dir/index.ts',
    },
    { form: 'workspace package', source: "import { lib } from '@acme/lib';", to: 'packages/lib' },
    {
      form: 'workspace package subpath',
      source: "import { format } from '@acme/lib/util/format';",
      to: 'packages/lib/src/util/format.ts',
    },
    {
      form: 'tsconfig paths without baseUrl through extends',
      source: "import { s } from '@shared/strings';",
      to: 'shared/strings.ts',
    },
  ])('resolves $form', ({ source, to, line = 1 }) => {
    const { edges } = measure({ ...repo, [entry]: `${source}\n` });
    expect(edges).toContainEqual({ from: entry, to, line });
  });

  it('skips imports in comments and counts unresolved bare imports as external', () => {
    const { edges, deps } = measure({
      ...repo,
      [entry]: [
        '/* import { h } from "./hidden";',
        "   import './hidden'; */",
        "// import { h } from './hidden';",
        'const text = "import { h } from \'./hidden\'";',
        "import { z } from 'zod';",
        "import { readFileSync } from 'node:fs';",
        '',
      ].join('\n'),
    });
    expect(edges.filter((edge) => edge.from === entry)).toEqual([]);
    expect(deps.external_imports).toBe(2);
    expect(deps.packages).toEqual([
      { dir: 'packages/app', name: '@acme/app', depends_on: ['packages/lib'] },
      { dir: 'packages/lib', name: '@acme/lib', depends_on: [] },
    ]);
    expect(deps.languages).toEqual(['JavaScript', 'TypeScript']);
  });
});

describe('Python imports', () => {
  const entry = 'src/app/sub/entry.py';
  const repo = {
    'pyproject.toml': '[project]\nname = "app"\ndependencies = ["requests>=2"]\n',
    'src/app/__init__.py': '',
    'src/app/core.py': 'thing = 1\n',
    'src/app/sub/__init__.py': '',
    'src/app/sub/leaf.py': 'x = 1\n',
    'tools/pyproject.toml': [
      '[project]',
      'name = "tools"',
      'dependencies = [',
      '  "App>=1",',
      ']',
      '[tool.uv.sources]',
      'app = { workspace = true }',
      '',
    ].join('\n'),
    'tools/tools_pkg/__init__.py': '',
    'tools/tools_pkg/run.py': 'def run():\n    pass\n',
  };
  it.each([
    { form: 'import a.b', source: 'import app.core', to: 'src/app/core.py' },
    {
      form: 'import with alias list',
      source: 'import os, app.core as core',
      to: 'src/app/core.py',
    },
    {
      form: 'from a.b import submodule',
      source: 'from app.sub import leaf',
      to: 'src/app/sub/leaf.py',
    },
    { form: 'from a.b import name', source: 'from app.core import thing', to: 'src/app/core.py' },
    { form: 'from . import x', source: 'from . import leaf', to: 'src/app/sub/leaf.py' },
    { form: 'from ..m import y', source: 'from ..core import thing', to: 'src/app/core.py' },
    { form: 'from .. import x', source: 'from .. import core', to: 'src/app/core.py' },
    {
      form: 'parenthesized names',
      source: 'from app import (\n    core,\n)',
      to: 'src/app/core.py',
    },
    {
      form: 'pyproject package root',
      source: 'import tools_pkg.run',
      to: 'tools/tools_pkg/run.py',
    },
  ])('resolves $form', ({ source, to }) => {
    const { edges } = measure({ ...repo, [entry]: `${source}\n` });
    expect(edges).toContainEqual({ from: entry, to, line: 1 });
  });

  it('skips imports in strings and comments and reads the package graph', () => {
    const { edges, deps } = measure({
      ...repo,
      [entry]: '"""\nimport app.core\n"""\n# from app import core\nimport json\n',
    });
    expect(edges.filter((edge) => edge.from === entry)).toEqual([]);
    expect(deps.external_imports).toBe(1);
    expect(deps.packages).toEqual([
      { dir: '.', name: 'app', depends_on: [] },
      { dir: 'tools', name: 'tools', depends_on: ['.'] },
    ]);
  });
});

describe('Go imports', () => {
  const entry = 'cmd/app/main.go';
  const repo = {
    'go.mod': [
      'module example.com/app',
      '',
      'go 1.22',
      '',
      'require (',
      '\texample.com/lib v0.0.0',
      '\tgithub.com/up/text v1.0.0',
      ')',
      '',
      'replace github.com/up/text => ./forks/text',
      '',
    ].join('\n'),
    'internal/store/store.go': 'package store\n',
    'internal/web/web.go': 'package web\n',
    'lib/go.mod': 'module example.com/lib\n',
    'lib/strings/strings.go': 'package strings\n',
    'forks/text/go.mod': 'module github.com/fork/text\n',
    'forks/text/wrap/wrap.go': 'package wrap\n',
  };
  it.each([
    {
      form: 'single import',
      source: 'import "example.com/app/internal/store"',
      to: 'internal/store',
      line: 3,
    },
    {
      form: 'aliased import',
      source: 'import _ "example.com/app/internal/store"',
      to: 'internal/store',
      line: 3,
    },
    {
      form: 'block import',
      source: 'import (\n\t"fmt"\n\tw "example.com/app/internal/web"\n)',
      to: 'internal/web',
      line: 5,
    },
    {
      form: 'another module of the repo',
      source: 'import "example.com/lib/strings"',
      to: 'lib/strings',
      line: 3,
    },
    {
      form: 'replace to a local path',
      source: 'import "github.com/up/text/wrap"',
      to: 'forks/text/wrap',
      line: 3,
    },
  ])('resolves $form', ({ source, to, line }) => {
    const { edges } = measure({ ...repo, [entry]: `package main\n\n${source}\n` });
    expect(edges).toContainEqual({ from: entry, to, line });
  });

  it('skips commented imports and reads the package graph', () => {
    const { edges, deps } = measure({
      ...repo,
      [entry]: 'package main\n\n// import "example.com/app/internal/web"\nimport "fmt"\n',
    });
    expect(edges.filter((edge) => edge.from === entry)).toEqual([]);
    expect(deps.external_imports).toBe(1);
    expect(deps.packages).toEqual([
      { dir: '.', name: 'example.com/app', depends_on: ['forks/text', 'lib'] },
      { dir: 'forks/text', name: 'github.com/fork/text', depends_on: [] },
      { dir: 'lib', name: 'example.com/lib', depends_on: [] },
    ]);
  });
});

describe('Rust imports', () => {
  const entry = 'src/net/http.rs';
  const repo = {
    'Cargo.toml': [
      '[package]',
      'name = "app"',
      '',
      '[workspace]',
      'members = ["crates/*"]',
      '',
      '[dependencies]',
      'text-utils = { path = "crates/text" }',
      'short = { package = "long-name", path = "crates/long" }',
      '',
      '[dev-dependencies.extra]',
      'path = "crates/extra"',
      '',
    ].join('\n'),
    'src/main.rs': 'mod config;\nmod net;\n',
    'src/config.rs': 'pub struct Settings;\n',
    'src/net/mod.rs': 'pub mod http;\npub mod tcp;\n',
    'src/net/tcp.rs': 'pub struct Stream;\n',
    'src/net/http/codec.rs': 'pub struct Codec;\n',
    'crates/text/Cargo.toml': '[package]\nname = "text-utils"\n',
    'crates/text/src/lib.rs': 'pub mod wrap;\n',
    'crates/text/src/wrap.rs': 'pub fn fill() {}\n',
    'crates/long/Cargo.toml': '[package]\nname = "long-name"\n',
    'crates/long/src/lib.rs': 'pub mod inner;\n',
    'crates/long/src/inner.rs': 'pub fn f() {}\n',
    'crates/extra/Cargo.toml': '[package]\nname = "extra"\n',
    'crates/extra/src/lib.rs': '',
  };
  it.each([
    { form: 'mod declaration', source: 'mod codec;', to: 'src/net/http/codec.rs' },
    { form: 'use crate path', source: 'use crate::config::Settings;', to: 'src/config.rs' },
    { form: 'use super path', source: 'use super::tcp::Stream;', to: 'src/net/tcp.rs' },
    { form: 'use self path', source: 'use self::codec::Codec;', to: 'src/net/http/codec.rs' },
    {
      form: 'grouped use',
      source: 'use crate::{config::Settings, net::{tcp, http}};',
      to: 'src/net/tcp.rs',
    },
    {
      form: 'repo crate with a dash',
      source: 'pub use text_utils::wrap::fill;',
      to: 'crates/text/src/wrap.rs',
    },
    {
      form: 'renamed path dependency',
      source: 'use short::inner::f;',
      to: 'crates/long/src/inner.rs',
    },
    {
      form: 'extern crate',
      source: 'pub extern crate text_utils as text;',
      to: 'crates/text/src/lib.rs',
    },
  ])('resolves $form', ({ source, to }) => {
    const { edges } = measure({ ...repo, [entry]: `${source}\n` });
    expect(edges).toContainEqual({ from: entry, to, line: 1 });
  });

  it('resolves both paths of a group, skips comments and strings and reads the package graph', () => {
    const { edges, deps } = measure({
      ...repo,
      [entry]: [
        'use crate::{config::Settings, net::tcp};',
        '// use crate::net::http::codec;',
        'const S: &str = "use crate::net::http::codec;";',
        'use std::io;',
        '',
      ].join('\n'),
    });
    expect(edges.filter((edge) => edge.from === entry)).toEqual([
      { from: entry, to: 'src/config.rs', line: 1 },
      { from: entry, to: 'src/net/tcp.rs', line: 1 },
    ]);
    expect(deps.external_imports).toBe(1);
    expect(deps.packages).toEqual([
      { dir: '.', name: 'app', depends_on: ['crates/extra', 'crates/long', 'crates/text'] },
      { dir: 'crates/extra', name: 'extra', depends_on: [] },
      { dir: 'crates/long', name: 'long-name', depends_on: [] },
      { dir: 'crates/text', name: 'text-utils', depends_on: [] },
    ]);
  });
});

describe('module edges', () => {
  const big: Record<string, string> = {
    'packages/big/package.json': JSON.stringify({ name: '@acme/big' }),
    'packages/big/src/index.ts':
      "import { f1 } from './a/f1.js';\nimport { g1 } from './b/g1.js';\n",
  };
  for (let i = 1; i <= 20; i++) {
    big[`packages/big/src/a/f${i}.ts`] = i === 1 ? "import { f2 } from './f2.js';\n" : '';
    big[`packages/big/src/b/g${i}.ts`] = i === 1 ? "import { f3 } from '../a/f3.js';\n" : '';
  }
  const files = {
    ...big,
    'packages/big/src/a/f1.test.ts': "import { g2 } from '../b/g2.js';\n",
    'packages/big/src/__tests__/setup.ts': "import { g3 } from '../b/g3.js';\n",
    'packages/small/package.json': JSON.stringify({
      name: '@acme/small',
      dependencies: { '@acme/big': '1.0.0' },
    }),
    'packages/small/src/main.ts':
      "// Entry\n\nimport { big } from '@acme/big';\nimport { f4 } from '@acme/big/a/f4';\n",
    'packages/small/src/other.ts': "import { main } from './main.js';\n",
    'scripts/tool/run.mjs': "import '../../packages/small/src/main.ts';\n",
    'tests/small.test.ts': "import '../packages/small/src/main.js';\n",
    'tests/helpers.ts': "import '../packages/small/src/other.js';\n",
    'ios/App.swift': 'import Foundation\n',
    'ios/View.swift': 'import SwiftUI\n',
    'native/lib.c': '#include "lib.h"\n',
  };

  it('splits a package of more than 40 files, drops edges inside a module and skips tests', () => {
    const { deps } = measure(files);
    expect(deps.modules).toEqual([
      {
        from: 'packages/big',
        to: 'packages/big/src/a',
        imports: 1,
        sample: 'file:packages/big/src/index.ts:1',
      },
      {
        from: 'packages/big',
        to: 'packages/big/src/b',
        imports: 1,
        sample: 'file:packages/big/src/index.ts:2',
      },
      {
        from: 'packages/big/src/b',
        to: 'packages/big/src/a',
        imports: 1,
        sample: 'file:packages/big/src/b/g1.ts:1',
      },
      {
        from: 'packages/small',
        to: 'packages/big',
        imports: 1,
        sample: 'file:packages/small/src/main.ts:3',
      },
      {
        from: 'packages/small',
        to: 'packages/big/src/a',
        imports: 1,
        sample: 'file:packages/small/src/main.ts:4',
      },
      {
        from: 'scripts/tool',
        to: 'packages/small',
        imports: 1,
        sample: 'file:scripts/tool/run.mjs:1',
      },
    ]);
    expect(deps.not_measured).toEqual([
      { language: 'Swift', files: 2 },
      { language: 'C', files: 1 },
    ]);
    expect(deps.languages).toEqual(['JavaScript', 'TypeScript']);
  });

  it('counts each import of a module edge and keeps the first as its sample', () => {
    const { deps } = measure({
      ...files,
      'packages/small/src/more.ts': "\nimport { big } from '@acme/big';\n",
    });
    expect(deps.modules).toContainEqual({
      from: 'packages/small',
      to: 'packages/big',
      imports: 2,
      sample: 'file:packages/small/src/main.ts:3',
    });
  });
});
