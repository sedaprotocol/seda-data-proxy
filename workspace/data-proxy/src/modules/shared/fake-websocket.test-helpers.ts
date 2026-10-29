/**
 * Test double for `globalThis.WebSocket`. Patch it in `beforeEach` and restore
 * the original constructor in `afterEach`.
 */
export class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	static sendImpl?: (instance: FakeWebSocket, data: string) => void;

	url: string;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	private readonly listenedTypes = new Set<string>();

	constructor(url: string) {
		super();
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		this.listenedTypes.add(type);
		super.addEventListener(type, listener, options);
	}

	/** The client can construct a socket and attach its listeners in separate scheduler ticks. */
	hasListener(type: string): boolean {
		return this.listenedTypes.has(type);
	}

	send(data: string): void {
		if (FakeWebSocket.sendImpl) {
			FakeWebSocket.sendImpl(this, data);
			return;
		}
		this.sent.push(data);
	}

	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent("close", { code: 1000, wasClean: true }));
	}

	triggerOpen(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	triggerMessage(data: string): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}

	triggerClose(code = 1000, reason = "", wasClean = true): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
	}

	triggerError(message = "socket error"): void {
		this.dispatchEvent(new ErrorEvent("error", { message }));
	}
}

export const installFakeWebSocket = (): (() => void) => {
	const original = globalThis.WebSocket;
	FakeWebSocket.instances = [];
	FakeWebSocket.sendImpl = undefined;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	return () => {
		globalThis.WebSocket = original;
	};
};
