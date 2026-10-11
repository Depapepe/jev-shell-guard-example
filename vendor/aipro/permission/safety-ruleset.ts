import type { Ruleset } from './types';
import { TOOLS } from '../agent/agents/prompt/tool-names';
import type { ShellType } from '../util/shell-utils';

/**
 * Safety Ruleset - 위험 명령 blocklist
 *
 * 에이전트 ruleset({ default: 'allow' }) 뒤에 append되어,
 * 위험 패턴을 'ask'로 승격시킵니다.
 * 사용자는 런타임에 "always"로 override 가능합니다.
 */
export const SAFETY_RULESET: Ruleset = [
  // rm -rf (common variants: split flags)
  { permission: TOOLS.RUN_COMMAND, pattern: '*rm -rf *', action: 'ask', consequence: 'may recursively force-remove files' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*rm -rf/*', action: 'ask', consequence: 'may recursively force-remove files' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*rm -r -f*', action: 'ask', consequence: 'may recursively force-remove files' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*rm -f -r*', action: 'ask', consequence: 'may recursively force-remove files' },
  // git force push
  { permission: TOOLS.RUN_COMMAND, pattern: '*git push*--force*', action: 'ask', consequence: 'may overwrite remote history' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*git push*-f *', action: 'ask', consequence: 'may overwrite remote history' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*git push*-f', action: 'ask', consequence: 'may overwrite remote history' },
  // git hard reset / clean / discard
  { permission: TOOLS.RUN_COMMAND, pattern: '*git reset --hard*', action: 'ask', consequence: 'may discard uncommitted changes' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*git clean*-f*', action: 'ask', consequence: 'may permanently delete untracked files' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*git checkout .*', action: 'ask', consequence: 'may discard working-tree changes' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*git restore .*', action: 'ask', consequence: 'may discard working-tree changes' },
  // git branch force delete
  { permission: TOOLS.RUN_COMMAND, pattern: '*git branch -D*', action: 'ask', consequence: 'may force-delete a branch' },
  // skip hooks
  { permission: TOOLS.RUN_COMMAND, pattern: '*--no-verify*', action: 'ask', consequence: 'may skip commit safety hooks' },
  // SQL destructive (case variants — matchPattern is case-sensitive)
  { permission: TOOLS.RUN_COMMAND, pattern: '*drop table*', action: 'ask', consequence: 'may drop a database table' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*DROP TABLE*', action: 'ask', consequence: 'may drop a database table' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*Drop Table*', action: 'ask', consequence: 'may drop a database table' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*drop database*', action: 'ask', consequence: 'may drop a database' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*DROP DATABASE*', action: 'ask', consequence: 'may drop a database' },
  { permission: TOOLS.RUN_COMMAND, pattern: '*Drop Database*', action: 'ask', consequence: 'may drop a database' },
];

// ============================================
// Critical command detection — one-time approval or non-interactive block
// ============================================

export interface HardlineMatch {
  id: string;
  reason: string;
}

const RM_BINARIES = new Set(['rm', '/bin/rm', '/usr/bin/rm']);
const RM_CATASTROPHIC_TARGETS = new Set([
  '/', '/*',
  '~', '~/', '~/*',
  '$HOME', '$HOME/', '$HOME/*',
  '${HOME}', '${HOME}/', '${HOME}/*',
]);

interface ScannedShellCommand {
  words: string[];
  outputRedirectTargets: string[];
  source: string;
}

interface ShellScanResult {
  commands: ScannedShellCommand[];
  nestedSources: string[];
}

interface RecursiveShellScanResult {
  commands: ScannedShellCommand[];
  hasUninspectedNestedSource: boolean;
}

interface ShellInvocation {
  executable: string;
  args: string[];
}

const MAX_NESTED_SHELL_DEPTH = 8;
const KNOWN_SYSTEM_BIN_DIRS = ['/bin/', '/usr/bin/', '/sbin/', '/usr/sbin/'];
const SHELL_EXECUTABLES = new Set(['sh', 'bash', 'dash', 'zsh']);
const SHELL_COMMAND_PREFIXES = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
const NO_OPTIONS_WITH_VALUE = new Set<string>();
const EXEC_OPTIONS_WITH_VALUE = new Set(['-a']);
const NICE_OPTIONS_WITH_VALUE = new Set(['-n', '--adjustment']);
const TIME_OPTIONS_WITH_VALUE = new Set(['-f', '--format', '-o', '--output']);
const STDBUF_OPTIONS_WITH_VALUE = new Set(['-i', '--input', '-o', '--output', '-e', '--error']);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(['-k', '--kill-after', '-s', '--signal']);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '--close-from',
  '-D',
  '--chdir',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-R',
  '--chroot',
  '-T',
  '--command-timeout',
  '-u',
  '--user',
]);
const ENV_OPTIONS_WITH_VALUE = new Set(['-C', '--chdir', '-S', '--split-string', '-u', '--unset']);

function executableName(word: string): string {
  if (!word.includes('/')) return word;
  const prefix = KNOWN_SYSTEM_BIN_DIRS.find(directory => word.startsWith(directory));
  return prefix && !word.slice(prefix.length).includes('/') ? word.slice(prefix.length) : word;
}

function isEnvironmentAssignment(word: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word);
}

function skipOptions(
  words: string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
): number {
  let index = start;
  while (index < words.length) {
    const option = words[index];
    if (option === '--') return index + 1;
    if (!option.startsWith('-') || option === '-') break;
    if (optionsWithValue.has(option)) index += 2;
    else index += 1;
  }
  return index;
}

/** Resolve only well-known wrappers; arbitrary wrapper inference would create hardline false positives. */
function resolveShellInvocation(command: Pick<ScannedShellCommand, 'words'>): ShellInvocation | null {
  const { words } = command;
  let index = 0;

  while (index < words.length && isEnvironmentAssignment(words[index])) index++;

  while (index < words.length) {
    const executable = executableName(words[index]);
    if (SHELL_COMMAND_PREFIXES.has(executable)) {
      index++;
      continue;
    }
    if (executable === 'sudo') {
      index = skipOptions(words, index + 1, SUDO_OPTIONS_WITH_VALUE);
      while (index < words.length && isEnvironmentAssignment(words[index])) index++;
      continue;
    }
    if (executable === 'env') {
      index = skipOptions(words, index + 1, ENV_OPTIONS_WITH_VALUE);
      while (index < words.length && isEnvironmentAssignment(words[index])) index++;
      continue;
    }
    if (executable === 'command' || executable === 'nohup' || executable === 'setsid') {
      index = skipOptions(words, index + 1, NO_OPTIONS_WITH_VALUE);
      continue;
    }
    if (executable === 'exec') {
      index = skipOptions(words, index + 1, EXEC_OPTIONS_WITH_VALUE);
      continue;
    }
    if (executable === 'nice') {
      index = skipOptions(words, index + 1, NICE_OPTIONS_WITH_VALUE);
      continue;
    }
    if (executable === 'time') {
      index = skipOptions(words, index + 1, TIME_OPTIONS_WITH_VALUE);
      continue;
    }
    if (executable === 'stdbuf') {
      index = skipOptions(words, index + 1, STDBUF_OPTIONS_WITH_VALUE);
      continue;
    }
    if (executable === 'timeout') {
      index = skipOptions(words, index + 1, TIMEOUT_OPTIONS_WITH_VALUE) + 1;
      continue;
    }
    return { executable, args: words.slice(index + 1) };
  }

  return null;
}

function readParenthesizedSubstitution(
  source: string,
  markerIndex: number,
): { content: string; endIndex: number } | null {
  const contentStart = markerIndex + 2;
  let depth = 1;
  let quote: "'" | '"' | null = null;

  for (let index = contentStart; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        index++;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '$' && next === '(') {
      depth++;
      index++;
      continue;
    }
    if (character === '(') depth++;
    if (character !== ')') continue;
    depth--;
    if (depth === 0) {
      return { content: source.slice(contentStart, index), endIndex: index };
    }
  }

  return null;
}

function readBacktickSubstitution(
  source: string,
  markerIndex: number,
): { content: string; endIndex: number } | null {
  for (let index = markerIndex + 1; index < source.length; index++) {
    if (source[index] === '\\') {
      index++;
      continue;
    }
    if (source[index] === '`') {
      return { content: source.slice(markerIndex + 1, index), endIndex: index };
    }
  }
  return null;
}

/**
 * Tokenize the small shell subset needed by the critical-command detector.
 * Quotes are removed using shell word semantics, while quoted operators stay
 * inside their word. Unsupported execution constructs return null so callers
 * can preserve the legacy detector instead of guessing.
 */
function scanSimpleShellCommands(source: string): ShellScanResult | null {
  const commands: ScannedShellCommand[] = [];
  const nestedSources: string[] = [];
  let words: string[] = [];
  let outputRedirectTargets: string[] = [];
  let word = '';
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  let pendingRedirect: 'input' | 'output' | null = null;

  const pushWord = (): void => {
    if (!hasWord) return;
    if (pendingRedirect) {
      if (pendingRedirect === 'output') outputRedirectTargets.push(word);
      pendingRedirect = null;
    } else {
      words.push(word);
    }
    word = '';
    hasWord = false;
  };

  const pushCommand = (): boolean => {
    pushWord();
    if (pendingRedirect) return false;
    if (words.length > 0 || outputRedirectTargets.length > 0) {
      commands.push({ words, outputRedirectTargets, source });
    }
    words = [];
    outputRedirectTargets = [];
    return true;
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (quote === "'") {
      if (character === "'") quote = null;
      else word += character;
      hasWord = true;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === '$' && next === '(') {
        const substitution = readParenthesizedSubstitution(source, index);
        if (!substitution) return null;
        nestedSources.push(substitution.content);
        word += '__shell_substitution__';
        hasWord = true;
        index = substitution.endIndex;
        continue;
      }
      if (character === '`') {
        const substitution = readBacktickSubstitution(source, index);
        if (!substitution) return null;
        nestedSources.push(substitution.content);
        word += '__shell_substitution__';
        hasWord = true;
        index = substitution.endIndex;
        continue;
      }
      if (character === '\\' && next !== undefined) {
        if (['$', '`', '"', '\\', '\n'].includes(next)) {
          word += next === '\n' ? '' : next;
          index++;
        } else {
          word += character;
        }
        hasWord = true;
        continue;
      }
      word += character;
      hasWord = true;
      continue;
    }

    if (character === '$' && next === '(') {
      const substitution = readParenthesizedSubstitution(source, index);
      if (!substitution) return null;
      nestedSources.push(substitution.content);
      word += '__shell_substitution__';
      hasWord = true;
      index = substitution.endIndex;
      continue;
    }
    if (character === '`') {
      const substitution = readBacktickSubstitution(source, index);
      if (!substitution) return null;
      nestedSources.push(substitution.content);
      word += '__shell_substitution__';
      hasWord = true;
      index = substitution.endIndex;
      continue;
    }

    if (character === '\\') {
      if (next === undefined) return null;
      if (next !== '\n') word += next;
      hasWord = true;
      index++;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      hasWord = true;
      continue;
    }

    if (character === '#' && !hasWord && pendingRedirect === null) {
      while (index + 1 < source.length && source[index + 1] !== '\n') index++;
      continue;
    }

    if (/\s/.test(character)) {
      pushWord();
      if (character === '\n' && !pushCommand()) return null;
      continue;
    }

    if ((character === '>' || character === '<') && next === '(') {
      const substitution = readParenthesizedSubstitution(source, index);
      if (!substitution) return null;
      nestedSources.push(substitution.content);
      word += '__shell_substitution__';
      hasWord = true;
      index = substitution.endIndex;
      continue;
    }

    if (character === '>' || character === '<') {
      if (character === '<' && next === '<') return null;
      if (hasWord && /^\d+$/.test(word)) {
        word = '';
        hasWord = false;
      } else {
        pushWord();
      }
      pendingRedirect = character === '>' ? 'output' : 'input';
      if (character === '>' && next === '>') index++;
      else if (character === '>' && next === '|') index++;
      continue;
    }

    if (pendingRedirect && character === '&' && !hasWord) {
      // `>&target` and `>& target` redirect to target; '&' is syntax, not
      // part of the target. Descriptor targets such as `>&1` remain benign.
      continue;
    }

    if (
      character === ';' ||
      character === '|' ||
      character === '&' ||
      character === '(' ||
      character === ')'
    ) {
      if (!pushCommand()) return null;
      if ((character === '|' || character === '&') && next === character) index++;
      continue;
    }

    word += character;
    hasWord = true;
  }

  if (quote || !pushCommand()) return null;
  return { commands, nestedSources };
}

function scanShellCommands(source: string, depth = 0): RecursiveShellScanResult | null {
  const scan = scanSimpleShellCommands(source);
  if (!scan) return null;
  const { commands, nestedSources } = scan;

  const nestedCommands: ScannedShellCommand[] = [];
  let hasUninspectedNestedSource = false;

  const appendNestedSource = (nestedSource: string): void => {
    if (depth >= MAX_NESTED_SHELL_DEPTH) {
      hasUninspectedNestedSource = true;
      return;
    }
    const nested = scanShellCommands(nestedSource, depth + 1);
    // Keep the structured outer commands when a nested payload uses syntax
    // outside this scanner's subset. Dropping the whole scan would route
    // quoted/escaped outer executables through the less precise legacy path.
    if (!nested) return;
    nestedCommands.push(...nested.commands);
    hasUninspectedNestedSource ||= nested.hasUninspectedNestedSource;
  };

  for (const nestedSource of nestedSources) {
    appendNestedSource(nestedSource);
  }
  for (const command of commands) {
    const invocation = resolveShellInvocation(command);
    if (!invocation) continue;

    if (SHELL_EXECUTABLES.has(invocation.executable)) {
      const commandOptionIndex = invocation.args.findIndex(
        argument => argument === '--command' || /^-[^-]*c/.test(argument),
      );
      const nestedSource =
        commandOptionIndex === -1 ? undefined : invocation.args[commandOptionIndex + 1];
      if (nestedSource !== undefined) {
        appendNestedSource(nestedSource);
      }
    } else if (invocation.executable === 'eval' && invocation.args.length > 0) {
      appendNestedSource(invocation.args.join(' '));
    } else if (invocation.executable === 'trap') {
      const actionIndex = invocation.args[0] === '--' ? 1 : 0;
      const action = invocation.args[actionIndex];
      if (action && !action.startsWith('-')) {
        appendNestedSource(action);
      }
    }
  }

  return {
    commands: [...commands, ...nestedCommands],
    hasUninspectedNestedSource,
  };
}

const RM_SHORT_OPTIONS = /^-[dfiIrvR]+$/;

function isRecursiveFlag(token: string): boolean {
  return token === '--recursive' || (RM_SHORT_OPTIONS.test(token) && /r/i.test(token));
}

function isForceFlag(token: string): boolean {
  return token === '--force' || (RM_SHORT_OPTIONS.test(token) && token.includes('f'));
}

const HOME_PATH_ALIASES = new Set(['~', '$HOME', '${HOME}']);

/** Normalize a shell path token for catastrophic target lookup. */
function normalizeShellPath(token: string): string {
  // Strip all double/single quote characters anywhere in the token.
  let normalized = token.replace(/["']/g, '');
  // Collapse repeated slashes to a single slash.
  normalized = normalized.replace(/\/{2,}/g, '/');
  // Resolve root-equivalent targets: split on '/', drop empty and '.' segments.
  // If nothing remains and the original target was absolute, it resolves to '/'.
  // e.g. /. → [], /./  → [], //.  → [] → all return '/'.
  // But /tmp/ → ['tmp'] → '/tmp', /.bashrc → ['bashrc'] stays, /... → ['...'] stays.
  const isAbsolute = normalized.startsWith('/');
  const inputSegments = normalized.split('/');
  const homeAlias =
    !isAbsolute && HOME_PATH_ALIASES.has(inputSegments[0]) ? inputSegments[0] : undefined;
  const segments: string[] = [];
  let hasEscapedHome = false;
  for (const segment of inputSegments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const removed = segments.pop();
      if (removed === homeAlias) hasEscapedHome = true;
      if (removed === undefined && !isAbsolute) segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  if (isAbsolute && segments.length === 0) {
    return '/';
  }
  // A recursive force-remove of HOME's parent (or a higher ancestor) is at
  // least as catastrophic as removing HOME itself. Keep the known alias so
  // the hardline target set catches `$HOME/..`, `$HOME/../..`, and peers.
  if (homeAlias && hasEscapedHome && segments.every(segment => segment === '..')) {
    return homeAlias;
  }
  return isAbsolute ? '/' + segments.join('/') : segments.join('/');
}

/** rm with recursive+force flags whose target is the filesystem root or home itself. */
function isRootWipeRm(commands: ScannedShellCommand[]): boolean {
  for (const command of commands) {
    const invocation = resolveShellInvocation(command);
    if (!invocation || invocation.executable !== 'rm') continue;
    const optionTerminator = invocation.args.indexOf('--');
    const optionArgs =
      optionTerminator === -1 ? invocation.args : invocation.args.slice(0, optionTerminator);
    const flags = optionArgs.filter(token => token.startsWith('-'));
    if (!flags.some(isRecursiveFlag) || !flags.some(isForceFlag)) continue;
    const targets = [
      ...optionArgs.filter(token => !token.startsWith('-')),
      ...(optionTerminator === -1 ? [] : invocation.args.slice(optionTerminator + 1)),
    ].map(normalizeShellPath);
    if (targets.some(target => RM_CATASTROPHIC_TARGETS.has(target))) return true;
  }
  return false;
}

/** Existing string detector retained only as a fallback for unsupported shell syntax. */
function legacyIsRootWipeRm(command: string): boolean {
  for (const segment of command.split(/[|;&]+/)) {
    const tokens = segment.trim().split(/\s+/);
    const rmIndex = tokens.findIndex(token => RM_BINARIES.has(token));
    if (rmIndex === -1) continue;
    const args = tokens.slice(rmIndex + 1);
    const flags = args.filter(t => t.startsWith('-'));
    if (!flags.some(isRecursiveFlag) || !flags.some(isForceFlag)) continue;
    const targets = args
      .filter(t => !t.startsWith('-'))
      .map(normalizeShellPath);
    if (targets.some(t => RM_CATASTROPHIC_TARGETS.has(t))) return true;
  }
  return false;
}

/** Raw block/disk device prefixes shared by dd and redirect checks so the lists can't drift. */
const BLOCK_DEVICE_PREFIX = '(?:sd|hd|nvme|vd|xvd|mmcblk|mapper\\/|md|disk)';
const BLOCK_DEVICE_PATH = new RegExp(
  String.raw`^\/dev\/` + BLOCK_DEVICE_PREFIX + String.raw`[a-z0-9._-]*(?:\/|$)`,
  'i',
);

const HARDLINE_REASONS = {
  rmRootWipe: 'recursive force rm targeting filesystem root or home',
  blockDeviceRedirect: 'redirects output onto a raw block device',
  mkfs: 'formats a raw block device filesystem (mkfs)',
  ddBlockDevice: 'dd writing directly to a raw block device',
  forkBomb: 'shell fork bomb',
  shredBlockDevice: 'shred overwriting a raw block device',
  wipefsBlockDevice: 'wipefs erasing all signatures on a raw block device',
  blkdiscardBlockDevice: 'blkdiscard discarding every block on a raw block device',
  cryptsetupDestroy: 'cryptsetup irreversibly destroying LUKS data on a raw block device',
  nestedShellDepth: 'nested shell execution exceeds the critical-command inspection limit',
  powershellRootRemove: 'PowerShell recursive force removal targeting a drive root or home',
  powershellClearDisk: 'PowerShell Clear-Disk erasing disk partition information',
  powershellFormatVolume: 'PowerShell formatting a filesystem volume',
  windowsFormatVolume: 'Windows format command formatting a filesystem volume',
} as const;

function isBlockDevicePath(value: string): boolean {
  return BLOCK_DEVICE_PATH.test(normalizeShellPath(value));
}

function hasShortOption(args: string[], option: string): boolean {
  return args.some(argument =>
    argument.startsWith('--') ? false : /^-[a-zA-Z]+$/.test(argument) && argument.includes(option),
  );
}

function hasBlockDeviceArg(args: string[]): boolean {
  return args.some(isBlockDevicePath);
}

const FORK_BOMB_REGEX = /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

function containsUnquotedForkBomb(source: string): boolean {
  let executableSyntax = '';
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === '\\' && quote === '"') index++;
      else if (character === quote) quote = null;
      executableSyntax += ' ';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      executableSyntax += ' ';
      continue;
    }
    if (character === '\\') {
      executableSyntax += '  ';
      index++;
      continue;
    }
    executableSyntax += character;
  }

  return FORK_BOMB_REGEX.test(executableSyntax);
}

interface PowerShellCommand {
  words: string[];
  isExecutable: boolean;
}

interface PowerShellScanContext {
  kind: 'source' | 'block' | 'hash' | 'expression';
  isHashKey: boolean;
  words: string[];
  word: string | null;
  quote: "'" | '"' | null;
  isHereString: boolean;
  isFirstWordQuoted: boolean;
  hasCallOperator: boolean;
  /** The current word began with a quote or an expression, whose end can start a comment. */
  isWordGrouped: boolean;
}

function scanPowerShellCommands(source: string): PowerShellCommand[] | null {
  const commands: PowerShellCommand[] = [];
  const parents: PowerShellScanContext[] = [];
  const createContext = (kind: PowerShellScanContext['kind']): PowerShellScanContext => ({
    kind,
    isHashKey: kind === 'hash',
    words: [],
    word: null,
    quote: null,
    isHereString: false,
    isFirstWordQuoted: false,
    hasCallOperator: false,
    isWordGrouped: false,
  });
  let context = createContext('source');
  let isTokenBoundary = true;

  const pushWord = (): void => {
    if (context.word === null) return;
    context.words.push(context.word);
    context.word = null;
    context.isWordGrouped = false;
  };
  const pushCommand = (): void => {
    pushWord();
    if (context.words.length > 0 && !context.isHashKey) {
      commands.push({
        words: context.words,
        isExecutable: !context.isFirstWordQuoted || context.hasCallOperator,
      });
    }
    context.words = [];
    context.isFirstWordQuoted = false;
    context.hasCallOperator = false;
  };
  const enterContext = (kind: PowerShellScanContext['kind']): void => {
    parents.push(context);
    context = createContext(kind);
  };
  // A statement that starts with a variable or a type literal (`$x`, `$x.Name`,
  // `$a, $b`, `[int]$x`) is an expression, where an unquoted `=` assigns.
  const isAssignmentTarget = (): boolean => {
    if (context.isFirstWordQuoted || context.hasCallOperator) return false;
    return /^[$[]/.test(context.words[0] ?? context.word ?? '');
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    const { quote } = context;
    const canStartComment = context.word === null || isTokenBoundary;
    isTokenBoundary = false;

    if (
      (quote === null || quote === '"') &&
      ((character === '$' && next === '(') ||
        (quote === null && (character === '(' || (character === '@' && next === '('))))
    ) {
      // Preserve the surrounding command (including switches after the expression).
      // Its result is unknown, but commands evaluated to produce it are inspectable.
      if (context.word === null) context.isWordGrouped = true;
      context.word = (context.word ?? '') + '__shell_substitution__';
      enterContext('expression');
      if (character !== '(') index++;
      continue;
    }

    if (quote) {
      if (character === '`' && quote === '"') {
        if (next === undefined) return null;
        context.word += next;
        index++;
      } else if (context.isHereString) {
        if (character === quote && next === '@' && /[\r\n]/.test(source[index - 1])) {
          // The newline immediately preceding the terminator is not string content.
          context.word = (context.word ?? '').replace(/(?:\r\n|[\r\n])$/, '');
          context.quote = null;
          context.isHereString = false;
          isTokenBoundary = context.isWordGrouped;
          index++;
        } else {
          context.word += character;
        }
      } else if (character === quote) {
        if (next === quote) {
          context.word += quote;
          index++;
        } else {
          context.quote = null;
          isTokenBoundary = context.isWordGrouped;
        }
      } else {
        context.word += character;
      }
      continue;
    }
    if (character === '`') {
      if (next === undefined) return null;
      if (next === '\r' && source[index + 2] === '\n') index++;
      else if (next !== '\n') context.word = (context.word ?? '') + next;
      index++;
      continue;
    }

    if (character === '<' && next === '#' && canStartComment) {
      // PowerShell block comments end at the first #>, even if they contain <#.
      const endIndex = source.indexOf('#>', index + 2);
      if (endIndex === -1) return null;
      pushWord();
      index = endIndex + 1;
      isTokenBoundary = true;
      continue;
    }
    if (character === '$' && next === '{') {
      // Braced variable names are words, not script-block bodies.
      context.word = (context.word ?? '') + '${';
      for (index += 2; index < source.length; index++) {
        context.word += source[index];
        if (source[index] === '`' && source[index + 1] !== undefined) {
          context.word += source[++index];
        } else if (source[index] === '}') break;
      }
      if (index === source.length) return null;
      continue;
    }

    if (character === '@' && next === '{') {
      if (context.word === null) context.isWordGrouped = true;
      context.word = (context.word ?? '') + '__shell_substitution__';
      enterContext('hash');
      index++;
      continue;
    }
    if (character === '}' || character === ')') {
      if (
        (character === ')' && context.kind !== 'expression') ||
        (character === '}' && context.kind !== 'block' && context.kind !== 'hash')
      )
        return null;
      pushCommand();
      const parent = parents.pop();
      if (!parent) return null;
      context = parent;
      isTokenBoundary = context.isWordGrouped;
      continue;
    }
    if (character === '{') {
      // Every block body is read. Whether one runs is not knowable from syntax: an
      // argument can be invoked downstream, and a declared or assigned body by a later
      // command (`function f {…}; f`, `& $block`, `Invoke-Command @params`).
      pushCommand();
      if (context.kind === 'hash') context.word = '__shell_substitution__';
      enterContext('block');
      continue;
    }
    if (character === '=' && context.kind === 'hash' && context.isHashKey) {
      pushCommand();
      context.isHashKey = false;
      continue;
    }
    // The right-hand side of an assignment runs now, so `$x = Remove-Item …` is a Remove-Item
    // command rather than one named `$x`; the target goes, with any `+` or `??` of the operator.
    // A `#` or `<#` glued to the `=` keeps the `=` in the word instead: where it is not really an
    // assignment (`$=#`, an argument after a block), PowerShell reads that `#` as text, so taking
    // it for a comment would hide the next command.
    if (
      character === '=' &&
      next !== '#' &&
      !(next === '<' && source[index + 2] === '#') &&
      isAssignmentTarget()
    ) {
      pushWord();
      context.words = [];
      continue;
    }

    const isHereString = character === '@' && (next === "'" || next === '"');
    if (character === "'" || character === '"' || isHereString) {
      if (context.word === null && context.words.length === 0) context.isFirstWordQuoted = true;
      if (context.word === null) context.isWordGrouped = true;
      context.quote = (isHereString ? next : character) === "'" ? "'" : '"';
      context.word ??= '';
      context.isHereString = isHereString;
      if (isHereString) {
        index += 2;
        while (source[index] === ' ' || source[index] === '\t') index++;
        if (source[index] === '\r' && source[index + 1] === '\n') index++;
        else if (source[index] !== '\r' && source[index] !== '\n') return null;
      }
      continue;
    }
    if (character === '#' && canStartComment) {
      while (index + 1 < source.length && !/[\r\n]/.test(source[index + 1])) index++;
      continue;
    }
    if (/\s/.test(character)) {
      pushWord();
      if (character === '\n' || character === '\r') {
        const hasWords = context.words.length > 0;
        pushCommand();
        if (context.kind === 'hash' && hasWords) context.isHashKey = true;
      }
      continue;
    }
    if (character === '&' && next !== '&' && context.word === null && context.words.length === 0) {
      context.hasCallOperator = true;
      continue;
    }
    if (';|&'.includes(character)) {
      pushCommand();
      if (character === ';' && context.kind === 'hash') context.isHashKey = true;
      if ((character === '|' || character === '&') && next === character) index++;
      continue;
    }
    context.word = (context.word ?? '') + character;
    // An index closes an expression token (`$a[0]#`), but inside a bareword (`x[1]#`) it is text.
    isTokenBoundary =
      character === ']' && (context.isWordGrouped || /^\$(?!\{)/.test(context.word));
  }

  if (context.quote || parents.length > 0) return null;
  pushCommand();
  return commands;
}

function powerShellExecutable(word: string): string {
  return (word.split(/[\\/]/).at(-1) ?? word).replace(/\.(?:exe|com)$/i, '').toLowerCase();
}

/**
 * A PowerShell command-line switch's name, lowercased: after `-`, `/`, pwsh's `--`, or
 * Git Bash's `//`, which reaches PowerShell as `/` where a lone `/c` would become a path.
 */
function powerShellSwitchName(argument: string): string | undefined {
  return /^(?:--?|\/\/?)(\w+)$/.exec(argument)?.[1]?.toLowerCase();
}

/** Windows PowerShell switches, by any prefix, whose argument is a script or encoded text. */
const WINDOWS_POWERSHELL_OPAQUE_SWITCHES = ['file', 'encodedcommand', 'ec'];
/** Windows PowerShell switches, by any prefix, that take a value. */
const WINDOWS_POWERSHELL_VALUE_SWITCHES = [
  'executionpolicy', 'ep', 'windowstyle', 'version', 'configurationname', 'inputformat', 'outputformat',
  'psconsolefile',
];

/**
 * Where Windows PowerShell's command starts without -Command: at the first argument that is
 * neither a switch nor a switch's value. -1 for a script or an encoded command, whose text
 * is not on the command line.
 */
function windowsPowerShellCommandStart(args: string[]): number {
  for (let index = 0; index < args.length; index++) {
    const name = powerShellSwitchName(args[index]);
    if (name === undefined) return index;
    const matches = (switches: string[]) => switches.some(full => full.startsWith(name));
    if (matches(WINDOWS_POWERSHELL_OPAQUE_SWITCHES)) return -1;
    if (matches(WINDOWS_POWERSHELL_VALUE_SWITCHES)) index++;
  }
  return -1;
}

/**
 * The `-Command` payload of a powershell/pwsh invocation, or undefined.
 *
 * Both nesting directions — PowerShell relaunching PowerShell, and a POSIX shell
 * launching it — route through here so the accepted spellings cannot drift apart
 * and quietly reopen one of them.
 */
function powerShellCommandPayload(rawExecutable: string, args: string[]): string | undefined {
  const executable = powerShellExecutable(rawExecutable);
  if (executable !== 'powershell' && executable !== 'pwsh') return undefined;
  // PowerShell takes any prefix of -Command: `-Co`, `/c`.
  const commandIndex = args.findIndex(argument => {
    const name = powerShellSwitchName(argument);
    return name !== undefined && 'command'.startsWith(name);
  });
  // PowerShell reads everything after -Command as the command, so an unquoted body
  // arrives as separate words. Taking only the next one would hand the rules a bare
  // `Remove-Item` and lose the `-Recurse -Force` and the path that make it critical.
  if (commandIndex !== -1) return args.slice(commandIndex + 1).join(' ') || undefined;
  // Without -Command, Windows PowerShell runs its first plain argument; pwsh runs a file.
  if (executable !== 'powershell') return undefined;
  const start = windowsPowerShellCommandStart(args);
  return start === -1 ? undefined : args.slice(start).join(' ');
}

function hasPowerShellSwitch(args: string[], names: string[]): boolean {
  return args.some(argument => {
    const normalized = argument.toLowerCase();
    if (normalized.endsWith(':$false')) return false;
    return names.some(name => normalized === `-${name}` || normalized === `-${name}:$true`);
  });
}

const POWERSHELL_REMOVE_COMMANDS = new Set(['remove-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir']);

function isPowerShellDryRun(args: string[]): boolean {
  return hasPowerShellSwitch(args, ['whatif', 'wh', 'wha', 'what', 'whati']);
}

/**
 * Targets of a Remove-Item call (or alias) that recurses and forces, or undefined for
 * any other command. Shared by the critical and the ask checks so their spellings
 * of the command and its switches cannot drift apart.
 */
function powerShellForceRemoveTargets(executable: string, args: string[]): string[] | undefined {
  if (!POWERSHELL_REMOVE_COMMANDS.has(executable) || isPowerShellDryRun(args)) return undefined;
  const hasRecurse = hasPowerShellSwitch(args, ['recurse', 'r', 're', 'rec', 'recu', 'recur', 'recurs']);
  const hasForce = hasPowerShellSwitch(args, ['force', 'fo', 'for', 'forc']);
  if (!hasRecurse || !hasForce) return undefined;
  const explicitPathIndex = args.findIndex(argument => /^-(?:path|literalpath)$/i.test(argument));
  return explicitPathIndex === -1
    ? args.filter(argument => !argument.startsWith('-'))
    : [args[explicitPathIndex + 1]];
}

/** `cmd /c rd /s /q …` or `cmd /c del /s /q …`: recursive removal with the prompt turned off. */
function isCmdQuietRecursiveRemove(executable: string, args: string[]): boolean {
  if (executable !== 'cmd') return false;
  // Git Bash needs `//c`: it rewrites a lone `/c` into a path, and cmd then runs nothing.
  const commandIndex = args.findIndex(argument => /^\/\/?c$/i.test(argument));
  if (commandIndex === -1) return false;
  return args
    .slice(commandIndex + 1)
    .join(' ')
    .split(/&&|\|\||[&|]/)
    .some(segment => {
      // `if exist build rd /s /q build` removes behind a check, also as `(rd …)`.
      const removal = segment
        .trim()
        .replace(/^if\s+(?:not\s+)?exist\s+(?:"[^"]*"|\S+)\s+\(?/i, '');
      const [name = '', ...words] = removal.split(/\s+/);
      const switches = words
        .filter(word => word.startsWith('/'))
        .flatMap(word => word.toLowerCase().split('/'));
      return (
        ['rd', 'rmdir', 'del', 'erase'].includes(name.toLowerCase()) &&
        switches.includes('s') &&
        switches.includes('q')
      );
    });
}

function isPowerShellRoot(value: string): boolean {
  const target = value.trim().replace(/\\/g, '/');
  return (
    /^[a-z]:\/(?:\*)?$/i.test(target) ||
    /^\/\/[^/]+\/[^/]+\/?(?:\*)?$/i.test(target) ||
    /^(?:\/(?:\*)?|~\/?\*?|\$home\/?\*?|\$\{home\}\/?\*?|\$env:userprofile\/?\*?|\$\{env:userprofile\}\/?\*?|\$env:systemdrive\/(?:\*)?)$/i.test(
      target,
    )
  );
}

function detectPowerShellHardline(source: string, depth = 0): HardlineMatch | null {
  const commands = scanPowerShellCommands(source);
  if (!commands) return null;

  for (const command of commands) {
    if (!command.isExecutable) continue;
    const [rawExecutable, ...args] = command.words;
    const executable = powerShellExecutable(rawExecutable);
    const isDryRun = isPowerShellDryRun(args);

    const removeTargets = powerShellForceRemoveTargets(executable, args);
    if (removeTargets?.some(target => target && isPowerShellRoot(target))) {
      return { id: 'powershell-root-remove', reason: HARDLINE_REASONS.powershellRootRemove };
    }
    if (!isDryRun && executable === 'clear-disk') {
      return { id: 'powershell-clear-disk', reason: HARDLINE_REASONS.powershellClearDisk };
    }
    if (!isDryRun && executable === 'format-volume') {
      return { id: 'powershell-format-volume', reason: HARDLINE_REASONS.powershellFormatVolume };
    }
    if (!isDryRun && executable === 'format' && args.some(argument => /^[a-z]:$/i.test(argument))) {
      return { id: 'windows-format-volume', reason: HARDLINE_REASONS.windowsFormatVolume };
    }

    const nestedSource = powerShellCommandPayload(rawExecutable, args);
    if (nestedSource) {
      if (depth >= MAX_NESTED_SHELL_DEPTH) {
        return { id: 'nested-shell-depth', reason: HARDLINE_REASONS.nestedShellDepth };
      }
      const nested = detectPowerShellHardline(nestedSource, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * The PowerShell counterpart of `rm -rf`: a recursive force removal written as
 * Remove-Item. One handed to cmd.exe is a shared rule, for every shell.
 */
function hasPowerShellRecursiveForceRemove(commands: PowerShellCommand[]): boolean {
  for (const command of commands) {
    const [rawExecutable, ...args] = command.words;
    // Without a path argument the items come through the pipeline, still removed.
    if (powerShellForceRemoveTargets(powerShellExecutable(rawExecutable), args)) return true;
  }
  return false;
}

/**
 * The lowercased scope a Set-ExecutionPolicy call binds, named or by position. Undefined
 * for an argument it does not recognize, so an unfamiliar call still asks.
 */
function setExecutionPolicyScope(args: string[]): string | undefined {
  const positional: string[] = [];
  let isPolicyNamed = false;
  let scope: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const parameter = /^-(\w+)(?::(.*))?$/.exec(args[index]);
    if (!parameter) {
      positional.push(args[index]);
      continue;
    }
    const name = parameter[1].toLowerCase();
    if ('force'.startsWith(name) || 'confirm'.startsWith(name) || name === 'cf') continue;
    const isScope = 'scope'.startsWith(name);
    if (!isScope && !'executionpolicy'.startsWith(name)) return undefined;
    // `-Scope Process`, `-Scope:Process`, or `-Scope: Process`.
    const value = parameter[2] || args[++index];
    if (isScope) scope = value;
    else isPolicyNamed = true;
  }
  // Unnamed values bind by position: -ExecutionPolicy first, then -Scope.
  if (!isPolicyNamed) positional.shift();
  if (scope === undefined) scope = positional.shift();
  return positional.length === 0 ? scope?.toLowerCase() : undefined;
}

/**
 * Set-ExecutionPolicy. Commands run under the user's execution policy, so changing it is
 * the user's call. The Process scope is not: it ends with the PowerShell that runs the
 * command, like `-ExecutionPolicy Bypass` on a nested PowerShell, which does not ask either.
 */
function setsPowerShellExecutionPolicy(commands: PowerShellCommand[]): boolean {
  for (const command of commands) {
    const [rawExecutable, ...args] = command.words;
    if (powerShellExecutable(rawExecutable) !== 'set-executionpolicy') continue;
    if (!isPowerShellDryRun(args) && setExecutionPolicyScope(args) !== 'process') return true;
  }
  return false;
}

/**
 * The PowerShell ask rules, for a PowerShell source and the `-Command` payload of each
 * powershell or pwsh it starts: wrapping a command in another PowerShell must not skip
 * the question.
 */
function detectPowerShellSensitive(source: string, depth = 0): string | null {
  const commands = (scanPowerShellCommands(source) ?? []).filter(command => command.isExecutable);
  if (hasPowerShellRecursiveForceRemove(commands)) return 'may recursively force-remove files';
  if (setsPowerShellExecutionPolicy(commands)) return 'may change the PowerShell execution policy';
  // The shared rules (rm, cmd, git) read the commands as PowerShell does. The POSIX scanner
  // cannot see into blocks or past assignments, and takes a backtick for a substitution.
  const structured = detectStructuredSensitive(commands);
  if (structured) return structured;
  // Deeper nesting is already critical in detectPowerShellHardline.
  if (depth >= MAX_NESTED_SHELL_DEPTH) return null;

  for (const command of commands) {
    const [rawExecutable, ...args] = command.words;
    const nestedSource = powerShellCommandPayload(rawExecutable, args);
    const consequence = nestedSource && detectPowerShellSensitive(nestedSource, depth + 1);
    if (consequence) return consequence;
  }
  return null;
}

/** The PowerShell ask rules for a PowerShell payload launched from a POSIX shell. */
function detectNestedPowerShellSensitive(commands: ScannedShellCommand[]): string | null {
  for (const command of commands) {
    const invocation = resolveShellInvocation(command);
    if (!invocation) continue;
    const source = powerShellCommandPayload(invocation.executable, invocation.args);
    if (!source) continue;

    const consequence = detectPowerShellSensitive(source);
    if (consequence) return consequence;
  }
  return null;
}

/**
 * A PowerShell payload launched from a POSIX shell still has to clear the PowerShell
 * rules. The surrounding scanner only knows POSIX shells, so it reads the payload as
 * an opaque argument and none of the cmdlet rules would ever see it.
 */
function detectNestedPowerShellHardline(commands: ScannedShellCommand[]): HardlineMatch | null {
  for (const command of commands) {
    const invocation = resolveShellInvocation(command);
    if (!invocation) continue;
    const source = powerShellCommandPayload(invocation.executable, invocation.args);
    if (!source) continue;

    const match = detectPowerShellHardline(source);
    if (match) return match;
  }
  return null;
}

function detectStructuredHardline(commands: ScannedShellCommand[]): HardlineMatch | null {
  if (isRootWipeRm(commands)) {
    return { id: 'rm-root-wipe', reason: HARDLINE_REASONS.rmRootWipe };
  }
  if (commands.some(command => command.outputRedirectTargets.some(isBlockDevicePath))) {
    return { id: 'block-device-redirect', reason: HARDLINE_REASONS.blockDeviceRedirect };
  }

  const invocations = commands
    .map(resolveShellInvocation)
    .filter((invocation): invocation is ShellInvocation => invocation !== null);

  if (
    invocations.some(
      invocation =>
        /^mkfs(?:\.[a-zA-Z0-9_+-]+)?$/.test(invocation.executable) &&
        hasBlockDeviceArg(invocation.args),
    )
  ) {
    return { id: 'mkfs', reason: HARDLINE_REASONS.mkfs };
  }
  if (
    invocations.some(
      invocation =>
        invocation.executable === 'dd' &&
        invocation.args.some(argument =>
          argument.startsWith('of=') ? isBlockDevicePath(argument.slice(3)) : false,
        ),
    )
  ) {
    return { id: 'dd-block-device', reason: HARDLINE_REASONS.ddBlockDevice };
  }
  const sources = new Set(commands.map(command => command.source));
  if ([...sources].some(containsUnquotedForkBomb)) {
    return { id: 'fork-bomb', reason: HARDLINE_REASONS.forkBomb };
  }
  if (
    invocations.some(
      invocation => invocation.executable === 'shred' && hasBlockDeviceArg(invocation.args),
    )
  ) {
    return { id: 'shred-block-device', reason: HARDLINE_REASONS.shredBlockDevice };
  }
  if (
    invocations.some(invocation => {
      if (invocation.executable !== 'wipefs' || !hasBlockDeviceArg(invocation.args)) return false;
      const isDryRun = invocation.args.includes('--no-act') || hasShortOption(invocation.args, 'n');
      const erasesAll = invocation.args.includes('--all') || hasShortOption(invocation.args, 'a');
      return erasesAll && !isDryRun;
    })
  ) {
    return { id: 'wipefs-block-device', reason: HARDLINE_REASONS.wipefsBlockDevice };
  }
  if (
    invocations.some(
      invocation => invocation.executable === 'blkdiscard' && hasBlockDeviceArg(invocation.args),
    )
  ) {
    return { id: 'blkdiscard-block-device', reason: HARDLINE_REASONS.blkdiscardBlockDevice };
  }
  if (
    invocations.some(
      invocation =>
        invocation.executable === 'cryptsetup' &&
        invocation.args.some(argument => ['luksFormat', 'luksErase', 'erase'].includes(argument)) &&
        hasBlockDeviceArg(invocation.args),
    )
  ) {
    return { id: 'cryptsetup-destroy', reason: HARDLINE_REASONS.cryptsetupDestroy };
  }

  return null;
}

/** `git`, `/usr/bin/git`, `git.exe` and `C:\Program Files\Git\cmd\git.exe` all run git. */
const executableBase = powerShellExecutable;

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C', '-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--work-tree',
]);

function resolveGitCommand(invocation: ShellInvocation): { operation: string; args: string[] } | null {
  if (executableBase(invocation.executable) !== 'git') return null;
  let index = 0;
  while (index < invocation.args.length && invocation.args[index].startsWith('-')) {
    const option = invocation.args[index];
    if (option === '--') {
      index++;
      break;
    }
    if (['--help', '--version', '-h', '-v'].includes(option)) return null;
    const name = option.split('=', 1)[0];
    const hasValue = option.includes('=') || /^-(?:C|c).+/.test(option);
    index += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(name) && !hasValue ? 2 : 1;
  }
  const operation = invocation.args[index];
  return operation ? { operation, args: invocation.args.slice(index + 1) } : null;
}

function gitRestoreHasPath(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') return index + 1 < args.length;
    if (argument === '--pathspec-from-file' || argument.startsWith('--pathspec-from-file=')) {
      return true;
    }
    if (argument === '--source' || argument === '-s' || argument === '--conflict') {
      index++;
      continue;
    }
    if (!argument.startsWith('-') || argument === '-') return true;
  }
  return false;
}

function detectStructuredSensitive(commands: Pick<ScannedShellCommand, 'words'>[]): string | null {
  for (const command of commands) {
    const invocation = resolveShellInvocation(command);
    if (!invocation) continue;
    const executable = executableBase(invocation.executable);

    if (executable === 'rm') {
      const separator = invocation.args.indexOf('--');
      const optionArgs = separator === -1 ? invocation.args : invocation.args.slice(0, separator);
      const flags = optionArgs.filter(argument => argument.startsWith('-'));
      const targets = [
        ...optionArgs.filter(argument => !argument.startsWith('-')),
        ...(separator === -1 ? [] : invocation.args.slice(separator + 1)),
      ];
      if (
        flags.some(isRecursiveFlag) &&
        flags.some(isForceFlag) &&
        targets.length > 0
      ) {
        return 'may recursively force-remove files';
      }
    }
    if (isCmdQuietRecursiveRemove(executable, invocation.args)) {
      return 'may recursively force-remove files';
    }

    const git = resolveGitCommand(invocation);
    if (
      git?.operation === 'push' &&
      !git.args.includes('--dry-run') &&
      !hasShortOption(git.args, 'n') &&
      git.args.some(
        argument => argument.startsWith('--force') || hasShortOption([argument], 'f'),
      )
    ) {
      return 'may overwrite remote history';
    }
    if (git?.operation === 'reset' && git.args.includes('--hard')) {
      return 'may discard uncommitted changes';
    }
    if (
      git?.operation === 'clean' &&
      (git.args.includes('--force') || hasShortOption(git.args, 'f')) &&
      !git.args.includes('--dry-run') &&
      !hasShortOption(git.args, 'n')
    ) {
      return 'may permanently delete untracked files';
    }
    const hasCheckoutPath =
      git?.operation === 'checkout' &&
      (git.args.includes('--force') ||
        hasShortOption(git.args, 'f') ||
        git.args.some(
          argument =>
            argument === '.' || argument.startsWith('./') || argument.startsWith('../'),
        ) ||
        (git.args.includes('--') && git.args.indexOf('--') + 1 < git.args.length));
    const hasRestorePath = git?.operation === 'restore' && gitRestoreHasPath(git.args);
    const onlyRestoresIndex =
      git?.operation === 'restore' &&
      git.args.some(argument => argument === '--staged' || hasShortOption([argument], 'S')) &&
      !git.args.some(argument => argument === '--worktree' || hasShortOption([argument], 'W'));
    if (
      (hasCheckoutPath || hasRestorePath) &&
      !onlyRestoresIndex &&
      (git?.operation === 'checkout' || git?.operation === 'restore')
    ) {
      return 'may discard working-tree changes';
    }
    const forceDeletesBranch =
      git?.operation === 'branch' &&
      (git.args.includes('-D') ||
        hasShortOption(git.args, 'D') ||
        ((git.args.includes('--delete') || hasShortOption(git.args, 'd')) &&
          (git.args.includes('--force') || hasShortOption(git.args, 'f'))));
    if (forceDeletesBranch) {
      return 'may force-delete a branch';
    }
  }
  return null;
}

/**
 * Legacy command-position anchor: matches start-of-string, or after a semicolon, pipe,
 * or && / || operator — not a mere substring. Prevents grep/echo/apt-get/quoted
 * false positives. Shared so the command-name checks below can't drift.
 *
 * This is used only when the quote-aware scanner cannot parse the command. In
 * that fallback, a metacharacter inside quotes can still cause a conservative
 * false positive, preserving the previous safety posture for unsupported syntax.
 */
const CMD_POSITION = String.raw`(?:^|[;|&\n]\s*|&&\s*|\|\|\s*)`;

const HARDLINE_REGEX_CHECKS: Array<{ id: string; reason: string; regex: RegExp }> = [
  {
    id: 'mkfs',
    reason: HARDLINE_REASONS.mkfs,
    regex: new RegExp(CMD_POSITION + String.raw`(?:sudo\s+)?mkfs(?:\.\w+)?(?:\s|$)`),
  },
  {
    id: 'dd-block-device',
    reason: HARDLINE_REASONS.ddBlockDevice,
    // Command-position anchor (like the siblings below) so quoted/prose mentions
    // — `echo "dd of=/dev/sda"` — are not blocked. Unbounded [^|;&]* (a single run is
    // linear, no ReDoS); a length bound would let arg padding push of= past the cap.
    regex: new RegExp(
      CMD_POSITION + String.raw`(?:sudo\s+)?dd\b[^|;&]*\bof=["']?\/dev\/` + BLOCK_DEVICE_PREFIX,
      'i',
    ),
  },
  {
    id: 'fork-bomb',
    reason: HARDLINE_REASONS.forkBomb,
    regex: FORK_BOMB_REGEX,
  },
  {
    id: 'shred-block-device',
    reason: HARDLINE_REASONS.shredBlockDevice,
    regex: new RegExp(
      CMD_POSITION + String.raw`(?:sudo\s+)?shred\b[^|;&]*\/dev\/` + BLOCK_DEVICE_PREFIX,
      'i',
    ),
  },
  {
    id: 'wipefs-block-device',
    reason: HARDLINE_REASONS.wipefsBlockDevice,
    // Require an erase-all flag (--all / -a) — bare `wipefs /dev/sdX` and the
    // dry-run forms (-n / --no-act) only list signatures and stay allowed.
    regex: new RegExp(
      CMD_POSITION +
        // Flag check is a zero-width lookahead so it isn't a second greedy run in
        // sequence with the device match — sequential `[^|;&]* … [^|;&]*` is the
        // quadratic-backtracking (ReDoS) shape. Both runs stay unbounded so arg
        // padding can't push /dev/ past a length cap (which would bypass the floor).
        String.raw`(?:sudo\s+)?wipefs\b(?=[^|;&]*(?:--all|(?<=\s)-a)\b)[^|;&]*\/dev\/` +
        BLOCK_DEVICE_PREFIX,
      'i',
    ),
  },
  {
    id: 'blkdiscard-block-device',
    reason: HARDLINE_REASONS.blkdiscardBlockDevice,
    regex: new RegExp(
      CMD_POSITION + String.raw`(?:sudo\s+)?blkdiscard\b[^|;&]*\/dev\/` + BLOCK_DEVICE_PREFIX,
      'i',
    ),
  },
  {
    id: 'cryptsetup-destroy',
    reason: HARDLINE_REASONS.cryptsetupDestroy,
    // Destructive subcommands only (format/erase) AND a /dev/ block-device target,
    // so reversible ops (open/close/luksAddKey) and file-backed test containers
    // (e.g. `cryptsetup luksFormat test.img`) are not floor-blocked.
    regex: new RegExp(
      CMD_POSITION +
        String.raw`(?:sudo\s+)?cryptsetup\s+(?:-\S+\s+)*(?:luksFormat|luksErase|erase)\b[^|;&]*\/dev\/` +
        BLOCK_DEVICE_PREFIX,
      'i',
    ),
  },
];

/** A redirect TARGET (the token right after `>`): a raw block device path.
 * Sticky ('y') so it can be tested at a given offset without slicing the command. */
const BLOCK_DEVICE_TARGET = new RegExp(
  String.raw`\/dev\/` + BLOCK_DEVICE_PREFIX + String.raw`[a-z0-9]*\b`,
  'iy',
);

/**
 * Detect an UNQUOTED shell redirect onto a raw block device (e.g. `cmd > /dev/sda`).
 * A redirect is a positional operator, so it can't be command-anchored like the
 * regex checks above; a plain substring regex blocks quoted/prose mentions
 * (`echo "x > /dev/sda"`). Scan tracking quote state instead, so only a real
 * unquoted redirect matches, and stop at an unquoted `#` (start of a shell comment,
 * which bash never runs). Best-effort: does not model backslash escapes or heredocs
 * — on that ambiguity the floor errs toward allowing.
 */
function legacyRedirectsToBlockDevice(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // Unquoted '#' at the start of a word (string start, whitespace, or right after a
    // control operator ; | &) starts a shell comment — the rest is inert, bash never runs it.
    if (ch === '#' && (i === 0 || ' \t;|&'.includes(command[i - 1]))) break;
    if (ch === '>') {
      let j = i + 1;
      while (command[j] === '>') j++;
      while (command[j] === ' ' || command[j] === '\t') j++;
      BLOCK_DEVICE_TARGET.lastIndex = j;
      if (BLOCK_DEVICE_TARGET.test(command)) return true;
    }
  }
  return false;
}

/** Detect commands that should require interactive approval without becoming hard blocks. */
export function detectSensitiveCommand(command: string, shell: ShellType = 'bash'): string | null {
  if (shell === 'powershell') {
    const powerShellConsequence = detectPowerShellSensitive(command);
    if (powerShellConsequence) return powerShellConsequence;
  }

  // For PowerShell, the POSIX reading still covers what the PowerShell one cannot: a `bash -c`
  // payload, and text the PowerShell scanner rejects. PowerShell has no backslash escapes, so
  // doubling them keeps a path such as `C:\Git\cmd\git.exe` whole.
  const scan = scanShellCommands(shell === 'powershell' ? command.replaceAll('\\', '\\\\') : command);
  if (!scan) return null;
  return detectStructuredSensitive(scan.commands) ?? detectNestedPowerShellSensitive(scan.commands);
}

/**
 * Detect critical commands that must never be auto-approved or persisted. Interactive
 * runtimes may require an explicit one-time confirmation; runtimes without
 * that dedicated confirmation path keep blocking the command.
 *
 * Precision over recall: only machine/filesystem-destroying commands belong
 * here; ordinary dangerous commands stay in SAFETY_RULESET.
 */
export function detectHardlineCommand(
  command: string,
  shell: ShellType = 'bash',
): HardlineMatch | null {
  if (shell === 'powershell') {
    const powershellMatch = detectPowerShellHardline(command);
    if (powershellMatch) return powershellMatch;
  }

  const scan = scanShellCommands(command);
  if (scan) {
    const match = detectStructuredHardline(scan.commands);
    if (match) return match;
    const nestedPowerShell = detectNestedPowerShellHardline(scan.commands);
    if (nestedPowerShell) return nestedPowerShell;
    if (scan.hasUninspectedNestedSource) {
      return { id: 'nested-shell-depth', reason: HARDLINE_REASONS.nestedShellDepth };
    }
    return null;
  }

  // Unsupported shell syntax retains the previous detector. This avoids
  // silently reducing the existing safety floor while keeping the structured
  // path precise for normal shell commands.
  if (legacyIsRootWipeRm(command)) {
    return { id: 'rm-root-wipe', reason: HARDLINE_REASONS.rmRootWipe };
  }
  if (legacyRedirectsToBlockDevice(command)) {
    return { id: 'block-device-redirect', reason: HARDLINE_REASONS.blockDeviceRedirect };
  }
  for (const check of HARDLINE_REGEX_CHECKS) {
    if (check.regex.test(command)) {
      return { id: check.id, reason: check.reason };
    }
  }
  return null;
}
