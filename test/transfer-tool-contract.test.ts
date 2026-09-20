/**
 * First-class transfer contract oracle (Stage 0).
 *
 * These tests intentionally stay red until Stage 3 registers
 * transfer({ transfers: [...] }). Existing transfer behavior remains covered by
 * transfer-edit.test.ts, transfer-regression.test.ts, and patch.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import smartEdit from "../src/index.js";

type ToolRegistration = {
    name: string;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
};

function createMockPI() {
    const _tools = new Map<string, ToolRegistration>();
    const _events = new Map<string, Set<(...args: unknown[]) => unknown>>();
    const bus = {
        subs: new Map<string, Set<(data: unknown) => void>>(),
        emit(channel: string, data: unknown) {
            for (const handler of this.subs.get(channel) ?? []) handler(data);
        },
        on(channel: string, handler: (data: unknown) => void) {
            const handlers = this.subs.get(channel) ?? new Set<(data: unknown) => void>();
            handlers.add(handler);
            this.subs.set(channel, handlers);
            return () => handlers.delete(handler);
        },
    };
    return {
        _tools,
        _events,
        events: { emit: bus.emit.bind(bus), on: bus.on.bind(bus) },
        on(event: string, handler: (...args: unknown[]) => unknown) {
            const handlers = _events.get(event) ?? new Set<(...args: unknown[]) => unknown>();
            handlers.add(handler);
            _events.set(event, handlers);
        },
        registerTool(tool: ToolRegistration) {
            _tools.set(tool.name, tool);
        },
    };
}

test("registered transfer tool exists", () => {
    const pi = createMockPI();
    smartEdit(pi as never);
    assert.ok(pi._tools.get("transfer"), "transfer tool must be registered");
});

test("registered tool surface exposes edit, not patch", () => {
    const pi = createMockPI();
    smartEdit(pi as never);
    assert.ok(pi._tools.has("edit"), "edit tool must be registered");
    assert.ok(!pi._tools.has("patch"), "patch tool must not be registered");
});

test("registered transfer schema accepts first-class transfers batch", () => {
    const pi = createMockPI();
    smartEdit(pi as never);
    const transfer = pi._tools.get("transfer");
    assert.ok(transfer, "transfer tool must be registered");
    assert.ok(transfer.parameters, "transfer tool must expose parameters");
    const parameters = transfer.parameters as { properties?: Record<string, unknown> };
    const transfers = parameters.properties?.transfers as Record<string, unknown> | undefined;
    assert.ok(transfers, "transfer schema must advertise transfers");
    assert.equal(transfers.type, "array");
    const item = transfers.items as Record<string, unknown>;
    assert.ok(item, "transfers must define item schema");
    const properties = item.properties as Record<string, unknown>;
    assert.deepEqual((properties.op as Record<string, unknown>).enum, ["copy", "move"]);
    assert.deepEqual(item.required, ["op", "from", "range", "to"]);
});
