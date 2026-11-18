/** 模块纪律规则 — pi-hear 强制层
 * 运行：npm run check:arch（pre-commit 自动拦截）
 * 规则含义见 AGENTS.md「模块纪律」节 */
module.exports = {
	forbidden: [
		{
			name: 'zero-runtime-deps',
			comment:
				'扩展运行时零 npm 依赖：hear.ts 只许 node: 内置、typebox、@earendil-works/pi 宿主；' +
				'要引其他包必须先在 package.json 加 dependencies 并说明理由',
			severity: 'error',
			from: { path: '(^|/)hear\\.ts$' },
			to: { pathNot: '^(node:|path|os|fs|child_process|typebox|node_modules/(typebox|@earendil-works))' },
		},
		{
			name: 'no-circular',
			comment: '禁止循环依赖（仅限本仓库代码，不管 node_modules 内部）',
			severity: 'error',
			from: { pathNot: 'node_modules' },
			to: { circular: true },
		},
	],
};
