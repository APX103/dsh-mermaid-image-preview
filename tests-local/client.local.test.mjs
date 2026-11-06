// Local-only harness for the modified lib/client.js: loads the bundle the way
// the DSH ModuleLoader does (window.__ModuleLoader__.load + factory(require)),
// runs apply(ctx) against a mock cordis ctx, and asserts the document-preview
// registration and the MermaidFileBody states. Not shipped; personal use.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let loaded = undefined
globalThis.window = {
	__ModuleLoader__: { load: (opts) => { loaded = opts } },
	location: { origin: 'http://gui.test:50240' },
}

// Execute the bundle exactly as the browser would: a plain script that
// registers its factory with the ModuleLoader.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInThisContext(source, { filename: 'lib/client.js' })

const react = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: () => {},
}

const requireShim = (name) => {
	if (name === 'react') return react
	throw new Error('unexpected require: ' + name)
}

assert.equal(typeof loaded, 'object', 'ModuleLoader.load captured')
assert.equal(loaded.id, '@baconbao/dsh-mermaid-image-preview')

const exports = loaded.factory(requireShim)
assert.equal(typeof exports.apply, 'function')
assert.deepEqual(exports.inject, ['slots'])

// --- mock cordis client ctx -------------------------------------------------
const registeredDefinitions = []
const slotInjections = []
const slotRegistrations = []
const services = {
	theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
	documentPreviews: {
		register: (definition) => { registeredDefinitions.push(definition); return () => {} },
	},
}
const ctx = {
	get: (name) => services[name],
	on: (event, listener) => () => {},
	effect: (fn, label) => { fn(); effects.push(label) },
	// Cordis `ctx.inject(deps, cb)` defers the callback until the named
	// services are live; the service mock is already "live" here.
	inject: (deps, callback) => callback({ get: (name) => services[name] }),
	slots: {
		inject: (slot, register) => { slotInjections.push(slot); register() },
		register: (meta, component) => { slotRegistrations.push({ meta, component }); return {} },
	},
}
const effects = []

// The real cordis context is a Proxy whose get trap THROWS on a property read
// of a service the plugin did not declare in its inject list. The plugin only
// declares ["slots"], so any `ctx.documentPreviews` property read must fail
// here exactly like it aborted the boot in 0.2.2-rc.1.
const proxiedCtx = new Proxy(ctx, {
	get(target, prop) {
		if (prop === 'documentPreviews') {
			throw new Error('cannot get property "documentPreviews" without inject')
		}
		return Reflect.get(target, prop)
	},
})

// Apply against the proxy: any `ctx.documentPreviews` property read would set
// off the trap above, proving the plugin reads the service only via ctx.get.
exports.apply(proxiedCtx)

// 1. registry metadata: extension band beats builtins, matches mmd/mermaid
assert.equal(registeredDefinitions.length, 1, 'one document definition registered')
const def = registeredDefinitions[0]
assert.equal(def.id, '@baconbao/dsh-mermaid-image-preview/mermaid-file')
assert.deepEqual(def.extensions, ['mmd', 'mermaid'])
assert.equal(def.priority, 'extension')
assert.equal(def.loading, 'text-pages')
assert.equal(def.wrap, false)
assert.equal(def.title(), 'Mermaid diagram')
assert.ok(effects.includes('mermaid-file: metadata'), 'metadata registered via ctx.effect')
assert.ok(effects.includes('mermaid-file: body'), 'body registered via ctx.effect')

// 2. keyed slot wiring
assert.ok(slotInjections.includes('sidebar.right.tab.document'), 'document slot injected')
const doc = slotRegistrations.find(r => r.meta.name === 'sidebar.right.tab.document')
assert.ok(doc, 'keyed document body registered')
assert.equal(doc.meta.key, '@baconbao/dsh-mermaid-image-preview/mermaid-file')
const face = doc.meta.inject()
assert.equal(face.theme, services.theme, 'theme face injected')
assert.equal(typeof face.onThemeChange, 'function', 'theme-change subscription injected')

// 3. component states --------------------------------------------------------
const MermaidFileBody = doc.component
const completeProps = {
	content: { kind: 'text', text: 'graph TD\n  A --> B\n', eof: true },
	theme: services.theme,
	onThemeChange: () => () => {},
}

const complete = MermaidFileBody(completeProps)
assert.equal(complete.type, 'div')
assert.equal(complete.props.className, 'dsh-mermaid-doc')
assert.equal(typeof complete.children[0].type, 'function', 'wraps the chat MermaidDiagram renderer component')
assert.equal(complete.children[0].props.code, 'graph TD\n  A --> B')
assert.equal(complete.children[0].props.scheme, 'dark', 'follows active color scheme')

const reading = MermaidFileBody({ ...completeProps, content: { kind: 'text', text: 'graph TD', eof: false } })
assert.match(reading.children[0].children[0], /Reading file\.\.\./, 'shows reading hint before EOF')

assert.equal(MermaidFileBody({ ...completeProps, content: { kind: 'bytes', data: new Uint8Array() } }), null, 'ignores non-text delivery')
assert.equal(MermaidFileBody({ ...completeProps, content: undefined }), null, 'ignores missing content')

// 4. degraded environment: documentPreviews never arrives -> the deferred
// inject never fires, nothing registers, and apply still must not throw.
const ctxWithoutRegistry = {
	get: (name) => (name === 'theme' ? services.theme : undefined),
	on: () => () => {},
	effect: (fn, label) => { fn() },
	inject: (deps, callback) => { /* service never provided: never run the callback */ },
	slots: { inject: (slot, register) => register(), register: (meta, comp) => ({}) },
}
exports.apply(ctxWithoutRegistry) // must not throw
console.log('ALL LOCAL CHECKS PASSED')
