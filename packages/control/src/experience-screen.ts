import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Improvement, Project } from '@pantheon/domain';

type Experience = Extract<Improvement['change'], { type: 'experience' }>;

/** Screen model text and its local citations at the boundary where it becomes trial guidance. */
export function screenExperience(
  project: Project,
  experience: Experience,
): { status_reason: string; status_detail: string } | undefined {
  const text = [experience.procedure, experience.countercondition ?? ''].join('\n');
  const risks: [string, RegExp][] = [
    [
      'network_access',
      /\b(?:https?|wss?|ftp):\/\/|\b(?:curl|wget|ssh|scp|sftp|netcat|telnet)\b|\b(?:fetch|XMLHttpRequest)\s*\(|\bgit\s+(?:push|pull|fetch|clone)\b|\b(?:requests|urllib|http|https)\.(?:get|post|request|urlopen)\b|网络访问|联网|出网/iu,
    ],
    [
      'credentials',
      /\b(?:credentials?|passwords?|secrets?|api[_ -]?keys?|access[_ -]?tokens?|authorization|bearer|private[_ -]?keys?|keychain)\b|\b[A-Z][A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b|(?:^|[\s/`])\.(?:env|ssh|aws)\b|凭据|密钥|密码/iu,
    ],
    [
      'destructive_command',
      /\b(?:rm|rmdir|unlink|shred|truncate|mkfs)\b|\bdd\s+.*\bof=|\bgit\s+(?:reset\s+--hard|clean\s+-|branch\s+-D)|\b(?:drop\s+(?:table|database)|delete\s+from)\b|递归删除|强制删除|清空数据库/iu,
    ],
    [
      'guardrail_relaxation',
      /\b(?:skip|bypass|disable|ignore|remove|loosen|weaken|turn\s+off)\b[^\n.!?]*(?:gate|sandbox|scope|approval|permission|certificate|guardrail|instruction|rule|check|test|verification)|--(?:no-verify|insecure|dangerously[\w-]*)\b|rejectUnauthorized\s*[:=]\s*false|(?:ssl[_ .-]?verify|verify)\s*[:=]\s*(?:false|0)|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|(?:绕过|跳过|忽略|关闭|禁用|放宽|削弱).*(?:护栏|审批|权限|沙箱|门禁|验证|检查|指令|规则)/iu,
    ],
  ];
  for (const [status_reason, pattern] of risks)
    if (pattern.test(text))
      return { status_reason, status_detail: `Experience text contains ${status_reason}` };

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  for (const root of project.roots) visit(root);
  const normalize = (line: string) =>
    line
      .trim()
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, '')
      .replace(/[`*_]/gu, '')
      .replace(/[.!?。！？]+$/u, '')
      .replace(/\s+/gu, ' ')
      .toLowerCase();
  const lines = text.split('\n').map(normalize);
  for (const file of files.filter((file) =>
    ['CLAUDE.md', 'AGENTS.md'].includes(path.basename(file)),
  )) {
    const rules = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !/^\s*(?:#|```|<!--)/u.test(line))
      .map(normalize);
    if (rules.some((rule) => rule && lines.some((line) => line.includes(rule))))
      return {
        status_reason: 'duplicate_instruction',
        status_detail: `Duplicates a line in ${file}`,
      };
  }

  const declares = (source: string, symbol: string) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(
      `\\b(?:function|class|interface|type|enum|const|let|var|def|func|struct|trait|fn)\\s+${escaped}\\b`,
      'u',
    ).test(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|^\s*#[^\n]*/gmu, ''));
  };
  const citedSymbols = new Set<string>();
  const references = text.matchAll(
    /(?:[\w./-]+\.[A-Za-z][A-Za-z0-9]*)(?:[:#]([A-Za-z_$][\w$]*)|:\d+(?::\d+)?)?/gu,
  );
  for (const reference of references) {
    const symbol = reference[1];
    const name = reference[0].replace(/[:#].*$/u, '');
    const matches = files.filter((file) =>
      project.roots.some((root) => path.resolve(root, name) === file),
    );
    if (
      !matches.length ||
      (symbol && !matches.some((file) => declares(readFileSync(file, 'utf8'), symbol)))
    )
      return {
        status_reason: 'invalid_reference',
        status_detail: `Citation does not exist: ${reference[0]}`,
      };
    if (symbol) citedSymbols.add(symbol);
  }
  for (const match of text.matchAll(
    /`([A-Za-z_$][\w$]*)\(\)`|\b(?:symbol|function|class|type)\s+`([A-Za-z_$][\w$]*)`/gu,
  )) {
    const symbol = (match[1] ?? match[2])!;
    if (citedSymbols.has(symbol)) continue;
    const sources = files.filter((file) =>
      /\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|swift|java|c|cpp|h)$/u.test(file),
    );
    if (!sources.some((file) => declares(readFileSync(file, 'utf8'), symbol)))
      return {
        status_reason: 'invalid_reference',
        status_detail: `Symbol does not exist: ${symbol}`,
      };
    citedSymbols.add(symbol);
  }
  return undefined;
}
