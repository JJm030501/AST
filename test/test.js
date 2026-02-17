/**
 * 反混淆工具单元测试
 */

const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;

const stringDecoder = require("../src/plugins/string_decoder");
const constantFolding = require("../src/plugins/constant_folding");
const controlFlow = require("../src/plugins/control_flow");
const deadCode = require("../src/plugins/dead_code");
const memberExpr = require("../src/plugins/member_expression");
const stringArrayDecoder = require("../src/plugins/string_array_decoder");
const hexNumber = require("../src/plugins/hex_number");
const commaExpr = require("../src/plugins/comma_expression");
const objectInline = require("../src/plugins/object_inline");
const antiDebug = require("../src/plugins/anti_debug");
const builtinEval = require("../src/plugins/builtin_static_eval");
const constProp = require("../src/plugins/const_propagation");
const iifeInline = require("../src/plugins/iife_inline");
const callApplyInline = require("../src/plugins/call_apply_inline");
const stringConcat = require("../src/plugins/string_concat");
const { extractWebpackModulesFromCode } = require("../src/webpack_extract");

function transform(code, pluginFn) {
  const ast = parser.parse(code, {
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });
  const plugin = pluginFn();
  traverse(ast, plugin.visitor);
  return generator(ast).code;
}

function normalize(code) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return "";
  const ast = parser.parse(trimmed, {
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });
  return generator(ast).code.trim();
}

function testCounter(name, input, pluginFn, minCount) {
  const ast = parser.parse(input, {
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });
  const counter = { count: 0 };
  const plugin = pluginFn({ counter });
  traverse(ast, plugin.visitor);
  const pass = counter.count >= minCount;
  console.log(`${pass ? "✓" : "✗"} [counter] ${name} (count=${counter.count}, min=${minCount})`);
  if (pass) {
    passed++;
  } else {
    failed++;
  }
}

let passed = 0, failed = 0;

function test(name, input, pluginFn, expected) {
  const result = transform(input, pluginFn);
  const resultN = normalize(result);
  let pass;
  if (typeof expected === "function") {
    pass = expected(resultN);
  } else {
    const expectedN = normalize(expected);
    pass = resultN === expectedN;
  }
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (pass) {
    passed++;
  } else {
    failed++;
    if (typeof expected !== "function") console.log(`  期望: ${normalize(expected)}`);
    console.log(`  实际: ${resultN}`);
  }
}

console.log("══════════════════════════════════════");
console.log("  反混淆工具单元测试");
console.log("══════════════════════════════════════\n");

// ── 常量折叠 ──
console.log("── 常量折叠 ──");
test("1 + 2 → 3", "var a = 1 + 2;", constantFolding, "var a = 3;");
test("!0 → true", "var a = !0;", constantFolding, "var a = true;");
test("!1 → false", "var a = !1;", constantFolding, "var a = false;");
test('"a"+"b" → "ab"', 'var a = "a" + "b";', constantFolding, 'var a = "ab";');
test("void 0 → undefined", "var a = void 0;", constantFolding, "var a = undefined;");
test("~5 → -6", "var a = ~5;", constantFolding, "var a = -6;");

// ── 十六进制数字还原 ──
console.log("\n── 十六进制数字还原 ──");
test("0xff → 255", "var a = 0xff;", hexNumber, "var a = 255;");
test("0x0 → 0", "var a = 0x0;", hexNumber, "var a = 0;");
test("0x1a2b → 6699", "var a = 0x1a2b;", hexNumber, "var a = 6699;");

// ── 成员表达式还原 ──
console.log("\n── 成员表达式还原 ──");
test('obj["log"] → obj.log', 'obj["log"]("test");', memberExpr, 'obj.log("test");');
test('a["push"] → a.push', 'a["push"](1);', memberExpr, 'a.push(1);');

// ── String.fromCharCode ──
console.log("\n── 字符串还原 ──");
test(
  "fromCharCode(72,101,108)",
  "var s = String.fromCharCode(72, 101, 108);",
  stringDecoder,
  'var s = "Hel";'
);

// ── 字符串数组动态解密 ──
console.log("\n── 字符串数组动态解密 ──");
test(
  "cached getter + rotation + decoder",
  `function _0xarr(){
  var _a = ["x","y","z","u","v"]; 
  _0xarr = function(){ return _a; };
  return _0xarr();
}
(function(_x,_n){ while(--_n){ _x.push(_x.shift()); } })(_0xarr(), 0x2);
function _0xdec(i){ var a = _0xarr(); return a[i]; }
var s = _0xdec(0x0);`,
  stringArrayDecoder,
  "var s = \"y\";"
);

test(
  "wrapper indirection + const expr args",
  `var _0xarr = ["AA","BB","CC","DD","EE"]; 
function _0xdec(i){ return _0xarr[i - 0x1]; }
function _0xwrap(a){ return _0xdec(a); }
var s = _0xwrap(0x10 ^ 0x11);`,
  stringArrayDecoder,
  "var s = \"AA\";"
);

test(
  "const id + parseInt + ~~ wrapper",
  `var _0xarr = ["AA","BB","CC","DD","EE"]; 
function _0xdec(i){ return _0xarr[i - 1]; }
function _0xwrap(a){ return _0xdec(~~a); }
const _k = parseInt("16") ^ 0x11;
var s = _0xwrap(_k);`,
  stringArrayDecoder,
  "var s = \"AA\";"
);

// ── 逗号表达式拆分 ──
console.log("\n── 逗号表达式拆分 ──");
test(
  "a=1, b=2 → 两条语句",
  "a = 1, b = 2;",
  commaExpr,
  "a = 1;\nb = 2;"
);

// ── 字符串拼接还原 ──
console.log("\n── 字符串拼接还原 ──");
test(
  's="ed"; s+="oNtn" → s="edoNtn"',
  'var s = "ed";\ns += "oNtn";\ns += "era";',
  stringConcat,
  'var s = "edoNtnera";'
);
test(
  'split-reverse-join 反转',
  'var d = "ev";\nd += "itim";\nd = (d += "irPot").split("").reverse().join("");',
  stringConcat,
  'var d = "toPrimitive";'
);
test(
  '交叉赋值 Ue = Ge += "ring"',
  'var Ge = "st";\nUe = Ge += "ring";',
  stringConcat,
  'var Ge = "string";\nUe = Ge;'
);

// ── 控制流平坦化还原 ──
console.log("\n── 控制流平坦化还原 ──");
test(
  "array seq + state var",
  `var _seq = ["2","0","1"], _idx = 0;
while (true) {
  var _s = _seq[_idx++];
  switch (_s) {
    case "0": a(); continue;
    case "1": b(); continue;
    case "2": c(); continue;
  }
  break;
}`,
  controlFlow,
  "c();\na();\nb();"
);

test(
  "state machine (numeric keys)",
  `var _state = 0;
while (true) {
  switch (_state) {
    case 0: a(); _state = 2; break;
    case 2: b(); _state = 1; break;
    case 1: c(); return;
  }
}`,
  controlFlow,
  "a();\nb();\nc();\nreturn;"
);

test(
  "state machine with conditional branch",
  `var _s = 0;
while (true) {
  switch (_s) {
    case 0: init(); _s = x > 0 ? 1 : 2; break;
    case 1: doA(); return;
    case 2: doB(); return;
  }
}`,
  controlFlow,
  `init();
if (x > 0) {
  doA();
  return;
} else {
  doB();
  return;
}`
);

test(
  "bitwise dispatch flatten (Pattern C)",
  `for (var s = 32; undefined !== s;) {
  switch (3 & s) {
    case 0:
      !function () {
        switch (3 & s >> 2) {
          case 0: a(); s = 1; break;
          case 1: b(); s = 2; break;
          case 2: c(); s = undefined; break;
        }
      }();
      break;
    case 1: d(); s = 4; break;
    case 2: e(); s = undefined; break;
  }
}`,
  controlFlow,
  (actual) => {
    return actual.includes("case 0:") && actual.includes("case 4:") &&
           actual.includes("case 8:") && actual.includes("a()") &&
           actual.includes("d()") && actual.includes("e()") &&
           !actual.includes("!function");
  }
);

// ── 死代码删除 ──
console.log("\n── 死代码删除 ──");
test(
  "if(false){...} → 删除",
  'if (false) { console.log("dead"); }',
  deadCode,
  ""
);
test(
  "if(true){A}else{B} → A",
  'if (true) { console.log("alive"); } else { console.log("dead"); }',
  deadCode,
  'console.log("alive");'
);

test(
  "while(false){...} → 删除",
  'while (false) { console.log("dead"); }',
  deadCode,
  ""
);
test(
  "for(;false;){...} → 删除",
  'for (;false;) { console.log("dead"); }',
  deadCode,
  ""
);

// ── 对象字典/包装器内联 ──
console.log("\n── 对象字典/包装器内联 ──");
test(
  'obj["k"] → "v"',
  'var _m = {"k":"v"}; var a = _m["k"];',
  objectInline,
  `var _m = {"k": "v"};
var a = "v";`
);
test(
  'obj["add"](1,2) → 1+2',
  'var _o = {"add": function(a,b){return a + b;}}; var x = _o["add"](1, 2);',
  objectInline,
  `var _o = {"add": function (a, b) {
  return a + b;
}};
var x = 1 + 2;`
);

// ── 常量传播 (安全内联) ──
console.log("\n── 常量传播 (安全内联) ──");
test(
  "var k=3; x=k+1 → x=3+1",
  "var k = 3; var x = k + 1;",
  constProp,
  "var x = 3 + 1;"
);
test(
  "var k=-3; x=Math.abs(k) → x=Math.abs(-3)",
  "var k = -3; var x = Math.abs(k);",
  constProp,
  "var x = Math.abs(-3);"
);

// ── IIFE/包装器内联 ──
console.log("\n── IIFE/包装器内联 ──");
test(
  "(function(a,b){return a+b;})(1,2) → 1+2",
  "var x = (function(a, b) { return a + b; })(1, 2);",
  iifeInline,
  "var x = 1 + 2;"
);

// ── call/apply 内联 ──
console.log("\n── call/apply 内联 ──");
test(
  "fn.call(null, a, b) → fn(a, b)",
  "var x = fn.call(null, a, b);",
  callApplyInline,
  "var x = fn(a, b);"
);
test(
  "fn.apply(null, [a, b]) → fn(a, b)",
  "var x = fn.apply(null, [a, b]);",
  callApplyInline,
  "var x = fn(a, b);"
);
test(
  "(0, obj.fn)(args) → obj.fn(args)",
  "var x = (0, obj.fn)(1, 2);",
  callApplyInline,
  "var x = obj.fn(1, 2);"
);

// ── 反调试清理 ──
console.log("\n── 反调试清理 ──");
test(
  "remove debugger statement",
  "debugger; var a = 1;",
  antiDebug,
  "var a = 1;"
);
test(
  "remove setInterval(debugger)",
  "setInterval(function(){debugger;}, 1000); var a = 1;",
  antiDebug,
  "var a = 1;"
);
test(
  "remove Function('debugger')()",
  "Function('debugger')(); var a = 1;",
  antiDebug,
  "var a = 1;"
);

// ── 安全内置函数静态求值 ──
console.log("\n── 安全内置函数静态求值 ──");
test(
  "Math.abs(-3) → 3",
  "var a = Math.abs(-3);",
  builtinEval,
  "var a = 3;"
);
test(
  "parseInt('ff',16) → 255",
  "var a = parseInt('ff', 16);",
  builtinEval,
  "var a = 255;"
);
test(
  "atob('QQ==') → 'A'",
  "var a = atob('QQ==');",
  builtinEval,
  "var a = \"A\";"
);

// ── 计数行为 ──
console.log("\n── 计数行为 ──");
testCounter(
  "constantFolding",
  "var a = 1 + 2;",
  constantFolding,
  1
);
testCounter(
  "hexNumber",
  "var a = 0xff;",
  hexNumber,
  1
);
testCounter(
  "memberExpr",
  'obj["log"]("test");',
  memberExpr,
  1
);
testCounter(
  "stringDecoder",
  "var s = String.fromCharCode(72, 101, 108);",
  stringDecoder,
  1
);
testCounter(
  "deadCode",
  'if (false) { console.log("dead"); }',
  deadCode,
  1
);
testCounter(
  "commaExpr",
  "a = 1, b = 2;",
  commaExpr,
  1
);
testCounter(
  "controlFlow",
  `var _seq = ["2","0","1"], _idx = 0;
while (true) {
  var _s = _seq[_idx++];
  switch (_s) {
    case "0": a(); continue;
    case "1": b(); continue;
    case "2": c(); continue;
  }
  break;
}`,
  controlFlow,
  1
);
testCounter(
  "builtinEval",
  "var a = Math.abs(-3);",
  builtinEval,
  1
);
testCounter(
  "constProp",
  "var k = 3; var x = k + 1;",
  constProp,
  1
);
testCounter(
  "antiDebug",
  "debugger; var a = 1;",
  antiDebug,
  1
);
testCounter(
  "objectInline",
  'var _m = {"k":"v"}; var a = _m["k"];',
  objectInline,
  1
);
testCounter(
  "iifeInline",
  "var x = (function(a, b) { return a + b; })(1, 2);",
  iifeInline,
  1
);
testCounter(
  "stringArrayDecoder",
  `function _0xarr(){
  var _a = ["x","y","z","u","v"];
  _0xarr = function(){ return _a; };
  return _0xarr();
}
(function(_x,_n){ while(--_n){ _x.push(_x.shift()); } })(_0xarr(), 0x2);
function _0xdec(i){ var a = _0xarr(); return a[i]; }
var s = _0xdec(0x0);`,
  stringArrayDecoder,
  1
);

// ── webpack bundle 模块提取(识别) ──
console.log("\n── webpack bundle 模块提取(识别) ──");
(() => {
  const code = `(function(mods){
  function __webpack_require__(id){ var m={exports:{}}; mods[id](m,m.exports,__webpack_require__); return m.exports; }
  return __webpack_require__(0);
})({
  0: function(module,exports,__webpack_require__){ module.exports = __webpack_require__(1); },
  1: function(module,exports){ module.exports = 123; }
});`;
  const ex = extractWebpackModulesFromCode(code);
  const pass = !!(ex && ex.modules && ex.modules.length === 2 && ex.modules.some((m) => m.id === "0") && ex.modules.some((m) => m.id === "1"));
  console.log(`${pass ? "✓" : "✗"} webpack bootstrap recognized`);
  if (pass) {
    passed++;
  } else {
    failed++;
    console.log(`  实际: ${ex ? JSON.stringify({ moduleCount: ex.moduleCount, ids: ex.modules ? ex.modules.map((m) => m.id) : [] }) : "null"}`);
  }
})();

(() => {
  const code = `var self = this;
(self["webpackChunkdemo"] = self["webpackChunkdemo"] || []).push([[1], {
  10: function(module){ module.exports = 10; },
  11: function(module){ module.exports = 11; }
}, function(){}]);`;
  const ex = extractWebpackModulesFromCode(code);
  const pass = !!(ex && ex.modules && ex.modules.length === 2 && ex.modules.some((m) => m.id === "10") && ex.modules.some((m) => m.id === "11"));
  console.log(`${pass ? "✓" : "✗"} webpackChunk push recognized`);
  if (pass) {
    passed++;
  } else {
    failed++;
    console.log(`  实际: ${ex ? JSON.stringify({ moduleCount: ex.moduleCount, ids: ex.modules ? ex.modules.map((m) => m.id) : [] }) : "null"}`);
  }
})();

(() => {
  const code = `var self = this;
var __mods__ = {
  20: function(module){ module.exports = 20; },
  21: function(module){ module.exports = 21; }
};
var payload = [[1], __mods__, function(){}];
(self["webpackChunkdemo"] = self["webpackChunkdemo"] || []).push(payload);`;
  const ex = extractWebpackModulesFromCode(code);
  const pass = !!(ex && ex.modules && ex.modules.length === 2 && ex.modules.some((m) => m.id === "20") && ex.modules.some((m) => m.id === "21"));
  console.log(`${pass ? "✓" : "✗"} webpackChunk push (identifier payload/modules) recognized`);
  if (pass) {
    passed++;
  } else {
    failed++;
    console.log(`  实际: ${ex ? JSON.stringify({ moduleCount: ex.moduleCount, ids: ex.modules ? ex.modules.map((m) => m.id) : [] }) : "null"}`);
  }
})();

// ── 汇总 ──
console.log(`\n══════════════════════════════════════`);
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
console.log(`══════════════════════════════════════\n`);
process.exit(failed > 0 ? 1 : 0);
