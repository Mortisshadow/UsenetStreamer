'use strict';

// Safe Stream Expression Language parser/evaluator. Adapted from the MIT
// licensed Usenet Ultimate project; see THIRD_PARTY_NOTICES.md.
// Deliberately does not use eval() or Function().

const ALLOWED_ATTRIBUTES = new Set([
  'resolution', 'codec', 'releaseGroup', 'visualTag', 'audioTag', 'videoTag',
  'edition', 'language', 'size', 'title', 'filename', 'indexer', 'age',
  'seeders', 'bitrate', 'seasonPack',
]);
const MAX_EXPRESSION_LENGTH = 8192;
const MAX_STRING_LENGTH = 1024;
const MAX_DEPTH = 32;

function tokenize(source) {
  if (typeof source !== 'string') throw new SyntaxError('SEL expression must be a string');
  if (source.length > MAX_EXPRESSION_LENGTH) throw new SyntaxError(`SEL expression exceeds ${MAX_EXPRESSION_LENGTH} characters`);
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const tokens = [];
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    const two = clean.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i }); i += 2; continue;
    }
    if ('+-*/!<>'.includes(ch)) { tokens.push({ type: 'op', value: ch, pos: i }); i += 1; continue; }
    if ('()[],.?:'.includes(ch)) { tokens.push({ type: 'punct', value: ch, pos: i }); i += 1; continue; }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i++;
      let value = '';
      while (i < clean.length && clean[i] !== quote) {
        if (clean[i] === '\\' && i + 1 < clean.length) {
          const escaped = clean[i + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else value += clean[i++];
        if (value.length > MAX_STRING_LENGTH) throw new SyntaxError(`SEL string exceeds ${MAX_STRING_LENGTH} characters at ${start}`);
      }
      if (i >= clean.length) throw new SyntaxError(`Unterminated SEL string at ${start}`);
      i += 1;
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }
    if (/\d/.test(ch)) {
      const start = i;
      while (i < clean.length && /[\d.]/.test(clean[i])) i += 1;
      if (/[kmgt]/i.test(clean[i] || '')) { i += 1; if (/b/i.test(clean[i] || '')) i += 1; }
      tokens.push({ type: 'number', value: clean.slice(start, i), pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < clean.length && /[A-Za-z0-9_]/.test(clean[i])) i += 1;
      tokens.push({ type: 'ident', value: clean.slice(start, i), pos: start });
      continue;
    }
    throw new SyntaxError(`Unexpected character '${ch}' at ${i}`);
  }
  tokens.push({ type: 'eof', value: '', pos: clean.length });
  return tokens;
}

function parseNumber(raw) {
  const match = raw.match(/^(\d+(?:\.\d+)?)([kmgt])?b?$/i);
  if (!match) throw new SyntaxError(`Invalid number '${raw}'`);
  const powers = { k: 1, m: 2, g: 3, t: 4 };
  return Number(match[1]) * (match[2] ? 1024 ** powers[match[2].toLowerCase()] : 1);
}

class Parser {
  constructor(tokens) { this.tokens = tokens; this.index = 0; this.depth = 0; }
  peek() { return this.tokens[this.index]; }
  take() { return this.tokens[this.index++]; }
  accept(type, value) {
    const token = this.peek();
    if (token.type === type && (value === undefined || token.value === value)) return this.take();
    return null;
  }
  expect(type, value) {
    const token = this.accept(type, value);
    if (!token) throw new SyntaxError(`Expected ${value || type} at ${this.peek().pos}`);
    return token;
  }
  parse() {
    const node = this.ternary();
    if (this.peek().type !== 'eof') throw new SyntaxError(`Unexpected '${this.peek().value}' at ${this.peek().pos}`);
    return node;
  }
  ternary() {
    const cond = this.or();
    if (!this.accept('punct', '?')) return cond;
    const then = this.ternary();
    this.expect('punct', ':');
    return { type: 'ternary', cond, then, else: this.ternary() };
  }
  or() {
    let left = this.and();
    while (this.accept('op', '||') || (this.peek().type === 'ident' && this.peek().value === 'or' && this.take())) {
      left = { type: 'or', left, right: this.and() };
    }
    return left;
  }
  and() {
    let left = this.not();
    while (this.accept('op', '&&') || (this.peek().type === 'ident' && this.peek().value === 'and' && this.take())) {
      left = { type: 'and', left, right: this.not() };
    }
    return left;
  }
  not() {
    if (this.accept('op', '!') || (this.peek().type === 'ident' && this.peek().value === 'not' && this.take())) {
      return { type: 'not', expr: this.not() };
    }
    return this.compare();
  }
  compare() {
    let left = this.add();
    while (true) {
      const token = this.peek();
      if (token.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
        this.take(); left = { type: 'compare', op: token.value, left, right: this.add() }; continue;
      }
      if (token.type === 'ident' && token.value === 'in') {
        this.take(); left = { type: 'in', left, right: this.add() }; continue;
      }
      return left;
    }
  }
  add() {
    let left = this.multiply();
    while (this.peek().type === 'op' && ['+', '-'].includes(this.peek().value)) {
      const op = this.take().value; left = { type: 'arith', op, left, right: this.multiply() };
    }
    return left;
  }
  multiply() {
    let left = this.unary();
    while (this.peek().type === 'op' && ['*', '/'].includes(this.peek().value)) {
      const op = this.take().value; left = { type: 'arith', op, left, right: this.unary() };
    }
    return left;
  }
  unary() { return this.accept('op', '-') ? { type: 'negateNumber', expr: this.unary() } : this.primary(); }
  primary() {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new SyntaxError(`SEL nesting exceeds ${MAX_DEPTH}`);
    try {
      if (this.accept('punct', '(')) { const node = this.ternary(); this.expect('punct', ')'); return node; }
      if (this.accept('punct', '[')) {
        const items = [];
        if (!this.accept('punct', ']')) {
          do { items.push(this.ternary()); } while (this.accept('punct', ','));
          this.expect('punct', ']');
        }
        return { type: 'array', items };
      }
      const ident = this.accept('ident');
      if (ident) {
        if (this.accept('punct', '(')) {
          const args = [];
          if (!this.accept('punct', ')')) {
            do { args.push(this.ternary()); } while (this.accept('punct', ','));
            this.expect('punct', ')');
          }
          return { type: 'call', name: ident.value, args };
        }
        if (ident.value === 'stream') {
          this.expect('punct', '.');
          const field = this.expect('ident').value;
          if (!ALLOWED_ATTRIBUTES.has(field)) throw new SyntaxError(`Unknown stream attribute '${field}'`);
          if (this.peek().value === '.') throw new SyntaxError('Deep attribute access is not allowed');
          return { type: 'attr', name: field };
        }
        if (ident.value === 'true') return { type: 'literal', value: true };
        if (ident.value === 'false') return { type: 'literal', value: false };
        if (ident.value === 'null') return { type: 'literal', value: null };
        return { type: 'identifier', name: ident.value };
      }
      const string = this.accept('string');
      if (string) return { type: 'literal', value: string.value };
      const number = this.accept('number');
      if (number) return { type: 'literal', value: parseNumber(number.value) };
      throw new SyntaxError(`Expected expression at ${this.peek().pos}`);
    } finally { this.depth -= 1; }
  }
}

function truthy(value) { return !(value === null || value === undefined || value === false || value === 0 || value === '' || (Array.isArray(value) && value.length === 0)); }
function compareValues(left, right, op) {
  if (left == null || right == null) return op === '==' ? left === right : op === '!=' ? left !== right : false;
  const numeric = typeof left === 'number' && typeof right === 'number';
  const a = numeric ? left : String(left).toLowerCase();
  const b = numeric ? right : String(right).toLowerCase();
  return op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
}
function evaluateNode(node, context) {
  switch (node.type) {
    case 'literal': return node.value;
    case 'array': return node.items.map((item) => evaluateNode(item, context));
    case 'attr': return context.stream?.[node.name];
    case 'identifier': return node.name === 'streams' ? context.streams : context.constants?.[node.name];
    case 'call': return (context.functions?.[node.name] || (() => []))(node.args.map((arg) => evaluateNode(arg, context)), context);
    case 'ternary': return truthy(evaluateNode(node.cond, context)) ? evaluateNode(node.then, context) : evaluateNode(node.else, context);
    case 'or': return truthy(evaluateNode(node.left, context)) || truthy(evaluateNode(node.right, context));
    case 'and': return truthy(evaluateNode(node.left, context)) && truthy(evaluateNode(node.right, context));
    case 'not': return !truthy(evaluateNode(node.expr, context));
    case 'negateNumber': { const value = evaluateNode(node.expr, context); return typeof value === 'number' ? -value : 0; }
    case 'compare': return compareValues(evaluateNode(node.left, context), evaluateNode(node.right, context), node.op);
    case 'in': {
      const left = evaluateNode(node.left, context); const right = evaluateNode(node.right, context);
      return Array.isArray(right) && right.some((item) => compareValues(left, item, '=='));
    }
    case 'arith': {
      const left = Number(evaluateNode(node.left, context)); const right = Number(evaluateNode(node.right, context));
      if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
      return node.op === '+' ? left + right : node.op === '-' ? left - right : node.op === '*' ? left * right : right === 0 ? 0 : left / right;
    }
    default: return undefined;
  }
}

function compile(expression) { return { ast: new Parser(tokenize(expression)).parse(), source: expression }; }
function evaluate(compiled, context) { return evaluateNode(compiled.ast, context); }

module.exports = { compile, evaluate, ALLOWED_ATTRIBUTES };
