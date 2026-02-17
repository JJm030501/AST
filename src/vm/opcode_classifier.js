/**
 * Opcode 语义分类器
 *
 * 输入: opcode handler 的 AST 节点 (来自 vm_analyzer 的 opcodeHandlers)
 * 输出: 语义分类标签
 *
 * 分类规则 (基于 handler 代码特征):
 *
 *   特征                                    | 分类
 *   ----------------------------------------|----------
 *   stack.push(code[pc++])                   | PUSH_CONST
 *   stack.push(literal)                      | PUSH_LITERAL
 *   stack.push(regs[x])                      | LOAD
 *   regs[x] = stack.pop()                    | STORE
 *   stack.push(stack.pop() + stack.pop())     | ADD
 *   stack.push(stack.pop() - stack.pop())     | SUB
 *   stack.push(stack.pop() * stack.pop())     | MUL
 *   stack.push(stack.pop() / stack.pop())     | DIV
 *   stack.push(stack.pop() % stack.pop())     | MOD
 *   stack.push(stack.pop() op stack.pop())    | BINOP
 *   stack.push(!stack.pop())                  | NOT
 *   stack.push(-stack.pop())                  | NEG
 *   stack.push(~stack.pop())                  | BITNOT
 *   stack.push(typeof stack.pop())            | TYPEOF
 *   pc = ...                                 | JMP
 *   if(...) pc = ...                         | JZ / JNZ
 *   stack.pop() 无 push                      | POP / DISCARD
 *   stack.push(func(...)) 或 .call/.apply    | CALL
 *   stack.push(obj[key])                     | GET_PROP
 *   obj[key] = val                           | SET_PROP
 *   return ...                               | RETURN
 *   仅 break/continue                        | NOP
 *   无法识别                                 | UNKNOWN
 */

const t = require("@babel/types");
const { visit } = require("../utils");

// ── 特征检测 ──

function countPatterns(stmts) {
  const counts = {
    pushCalls: 0,
    popCalls: 0,
    pcAssigns: 0,
    conditionalPcAssigns: 0,
    binaryOps: [],
    unaryOps: [],
    memberReads: 0,
    memberWrites: 0,
    functionCalls: 0,
    returnStmts: 0,
    codeReads: 0,
    regsReads: 0,
    regsWrites: 0,
    totalStmts: 0,
  };

  // 用于检测的变量名 (从上下文推断)
  const vars = {
    stack: null,
    regs: null,
    code: null,
    pc: null,
  };

  for (const stmt of stmts) {
    if (t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) continue;
    counts.totalStmts++;

    visit(stmt, (n) => {
      // push 调用
      if (
        t.isCallExpression(n) &&
        t.isMemberExpression(n.callee) &&
        !n.callee.computed
      ) {
        const prop = n.callee.property;
        if (t.isIdentifier(prop, { name: "push" })) {
          counts.pushCalls++;
          if (t.isIdentifier(n.callee.object)) vars.stack = n.callee.object.name;
        }
        if (t.isIdentifier(prop, { name: "pop" })) {
          counts.popCalls++;
          if (t.isIdentifier(n.callee.object)) vars.stack = n.callee.object.name;
        }
        if (
          t.isIdentifier(prop, { name: "call" }) ||
          t.isIdentifier(prop, { name: "apply" })
        ) {
          counts.functionCalls++;
        }
      }

      // computed push/pop: stack["push"](...)
      if (
        t.isCallExpression(n) &&
        t.isMemberExpression(n.callee) &&
        n.callee.computed &&
        t.isStringLiteral(n.callee.property)
      ) {
        if (n.callee.property.value === "push") counts.pushCalls++;
        if (n.callee.property.value === "pop") counts.popCalls++;
      }

      // 二元运算符
      if (t.isBinaryExpression(n)) {
        counts.binaryOps.push(n.operator);
      }

      // 一元运算符
      if (t.isUnaryExpression(n)) {
        counts.unaryOps.push(n.operator);
      }

      // pc 赋值
      if (t.isAssignmentExpression(n)) {
        // regs[x] = ...
        if (t.isMemberExpression(n.left) && n.left.computed) {
          if (t.isIdentifier(n.left.object)) {
            counts.regsWrites++;
            counts.memberWrites++;
          }
        }
      }

      // regs[x] 读
      if (
        t.isMemberExpression(n) &&
        n.computed &&
        t.isIdentifier(n.object)
      ) {
        counts.regsReads++;
        counts.memberReads++;
      }

      // return
      if (t.isReturnStatement(n)) {
        counts.returnStmts++;
      }

      // 函数调用 (非 push/pop/call/apply)
      if (t.isCallExpression(n) && t.isIdentifier(n.callee)) {
        counts.functionCalls++;
      }
    });
  }

  // 检测 pc 赋值 (包括条件分支中的)
  for (const stmt of stmts) {
    if (t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) continue;

    visit(stmt, (n) => {
      if (!t.isAssignmentExpression(n)) return;
      // 简单启发式: 如果左侧是简单标识符且右侧涉及数值或 code 读取
      if (t.isIdentifier(n.left)) {
        // 检查是否是 pc 类变量 (被赋值为数值 / code[pc] / 表达式)
        const isInsideIf = stmts.some((s) => {
          let found = false;
          if (t.isIfStatement(s)) {
            visit(s, (inner) => {
              if (inner === n) found = true;
            });
          }
          return found;
        });

        if (isInsideIf) {
          counts.conditionalPcAssigns++;
        }
        counts.pcAssigns++;
      }
    });
  }

  return { counts, vars };
}

// ── 分类逻辑 ──

const OPCODES = {
  PUSH_CONST: "PUSH_CONST",
  PUSH_LITERAL: "PUSH_LITERAL",
  LOAD: "LOAD",
  STORE: "STORE",
  ADD: "ADD",
  SUB: "SUB",
  MUL: "MUL",
  DIV: "DIV",
  MOD: "MOD",
  BINOP: "BINOP",
  NOT: "NOT",
  NEG: "NEG",
  BITNOT: "BITNOT",
  TYPEOF: "TYPEOF",
  UNARY: "UNARY",
  JMP: "JMP",
  JZ: "JZ",
  JNZ: "JNZ",
  COND_JMP: "COND_JMP",
  POP: "POP",
  CALL: "CALL",
  GET_PROP: "GET_PROP",
  SET_PROP: "SET_PROP",
  RETURN: "RETURN",
  NOP: "NOP",
  UNKNOWN: "UNKNOWN",
};

const BINOP_MAP = {
  "+": OPCODES.ADD,
  "-": OPCODES.SUB,
  "*": OPCODES.MUL,
  "/": OPCODES.DIV,
  "%": OPCODES.MOD,
};

const UNARY_MAP = {
  "!": OPCODES.NOT,
  "-": OPCODES.NEG,
  "~": OPCODES.BITNOT,
  "typeof": OPCODES.TYPEOF,
};

/**
 * 分类单个 opcode handler
 *
 * @param {object} handler - { opcode, stmts, code }
 * @returns {{ label: string, confidence: number, detail: string }}
 */
function classifyHandler(handler) {
  const { stmts, code } = handler;
  if (!stmts || stmts.length === 0) {
    return { label: OPCODES.NOP, confidence: 0.9, detail: "empty handler" };
  }

  const { counts } = countPatterns(stmts);

  // NOP: 只有 break/continue
  if (counts.totalStmts === 0) {
    return { label: OPCODES.NOP, confidence: 0.9, detail: "break/continue only" };
  }

  // RETURN
  if (counts.returnStmts > 0 && counts.pushCalls === 0) {
    return { label: OPCODES.RETURN, confidence: 0.8, detail: "return statement" };
  }

  // STORE: regsWrites > 0, popCalls > 0, pushCalls === 0
  if (counts.regsWrites > 0 && counts.popCalls > 0 && counts.pushCalls === 0) {
    return { label: OPCODES.STORE, confidence: 0.8, detail: "regs[x] = stack.pop()" };
  }

  // LOAD: pushCalls > 0, regsReads > 0, popCalls === 0
  if (counts.pushCalls > 0 && counts.regsReads > 0 && counts.popCalls === 0) {
    return { label: OPCODES.LOAD, confidence: 0.7, detail: "stack.push(regs[x])" };
  }

  // POP/DISCARD: popCalls > 0, pushCalls === 0, pcAssigns === 0
  if (counts.popCalls > 0 && counts.pushCalls === 0 && counts.pcAssigns === 0 && counts.regsWrites === 0) {
    return { label: OPCODES.POP, confidence: 0.7, detail: "stack.pop() discard" };
  }

  // COND_JMP: conditionalPcAssigns > 0
  if (counts.conditionalPcAssigns > 0 && counts.popCalls > 0) {
    return { label: OPCODES.COND_JMP, confidence: 0.7, detail: "conditional pc assign" };
  }

  // JMP: pcAssigns > 0, popCalls === 0, pushCalls === 0
  if (counts.pcAssigns > 0 && counts.popCalls === 0 && counts.pushCalls === 0 && counts.totalStmts <= 2) {
    return { label: OPCODES.JMP, confidence: 0.6, detail: "unconditional pc assign" };
  }

  // BINOP: pushCalls > 0, popCalls >= 2, has binary ops
  if (counts.pushCalls > 0 && counts.popCalls >= 2 && counts.binaryOps.length > 0) {
    const mainOp = counts.binaryOps[0];
    const label = BINOP_MAP[mainOp] || OPCODES.BINOP;
    return { label, confidence: 0.75, detail: `binary: ${mainOp}` };
  }

  // UNARY: pushCalls > 0, popCalls === 1, has unary ops
  if (counts.pushCalls > 0 && counts.popCalls === 1 && counts.unaryOps.length > 0) {
    const mainOp = counts.unaryOps[0];
    const label = UNARY_MAP[mainOp] || OPCODES.UNARY;
    return { label, confidence: 0.7, detail: `unary: ${mainOp}` };
  }

  // CALL: functionCalls > 0 or .call/.apply
  if (counts.functionCalls > 0 && counts.popCalls > 0) {
    return { label: OPCODES.CALL, confidence: 0.6, detail: "function call" };
  }

  // GET_PROP: push + member read + pop
  if (counts.pushCalls > 0 && counts.memberReads > 0 && counts.popCalls > 0 && counts.binaryOps.length === 0) {
    return { label: OPCODES.GET_PROP, confidence: 0.5, detail: "property read" };
  }

  // SET_PROP: member write + pop, no push
  if (counts.memberWrites > 0 && counts.popCalls > 0 && counts.pushCalls === 0) {
    return { label: OPCODES.SET_PROP, confidence: 0.5, detail: "property write" };
  }

  // PUSH_CONST: push + code read (code[pc++] pattern)
  if (counts.pushCalls > 0 && counts.popCalls === 0) {
    return { label: OPCODES.PUSH_CONST, confidence: 0.5, detail: "push without pop" };
  }

  return { label: OPCODES.UNKNOWN, confidence: 0, detail: "unrecognized pattern" };
}

/**
 * 分类全部 opcode handlers
 *
 * @param {Array} handlers - vm_analyzer 输出的 opcodeHandlers
 * @returns {Array<{ opcode, label, confidence, detail }>}
 */
function classifyAllHandlers(handlers) {
  if (!handlers || !Array.isArray(handlers)) return [];

  return handlers.map((h) => {
    const result = classifyHandler(h);
    return {
      opcode: h.opcode,
      ...result,
    };
  });
}

/**
 * 生成分类统计摘要
 */
function classifySummary(classified) {
  const labelCounts = {};
  const opcodesByLabel = {};

  for (const c of classified) {
    if (!labelCounts[c.label]) labelCounts[c.label] = 0;
    labelCounts[c.label]++;
    if (!opcodesByLabel[c.label]) opcodesByLabel[c.label] = [];
    opcodesByLabel[c.label].push(c.opcode);
  }

  return {
    total: classified.length,
    uniqueLabels: Object.keys(labelCounts).length,
    labelCounts,
    opcodesByLabel,
  };
}

module.exports = {
  classifyHandler,
  classifyAllHandlers,
  classifySummary,
  OPCODES,
};
