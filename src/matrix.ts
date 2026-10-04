interface MatrixLoginResponse {
  access_token: string;
  user_id: string;
  device_id?: string;
}

interface MatrixErrorBody {
  errcode?: string;
  error?: string;
  retry_after_ms?: number;
}

export class MatrixError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}

export class MatrixClient {
  private accessToken: string | null = null;
  private directRooms: Record<string, string[]> | null = null;
  private directRoomsPromise: Promise<Record<string, string[]>> | null = null;
  private directWriteQueue: Promise<void> = Promise.resolve();
  private roomPromises = new Map<string, Promise<string>>();

  constructor(
    readonly baseUrl: string,
    readonly userId: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  get connected(): boolean {
    return this.accessToken !== null;
  }

  async login(secret: string, _credentialKind: 'login-token' | 'password' = 'password'): Promise<void> {
    const response = await this.request<MatrixLoginResponse>('/_matrix/client/v3/login', {
      method: 'POST',
      anonymous: true,
      body: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: this.userId },
        password: secret,
        device_id: 'DJS_BROADCAST_WEB',
        initial_device_display_name: 'djs-broadcast'
      }
    });
    if (!response.access_token) {
      throw new MatrixError('Der Chatserver hat keinen Access-Token zurückgegeben.', 502);
    }
    this.accessToken = response.access_token;
    this.directRooms = null;
    this.directRoomsPromise = null;
  }

  async logout(): Promise<void> {
    if (!this.accessToken) return;
    try {
      await this.request('/_matrix/client/v3/logout', { method: 'POST', body: {} });
    } finally {
      this.accessToken = null;
      this.directRooms = null;
      this.directRoomsPromise = null;
      this.roomPromises.clear();
    }
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    options: { method?: string; body?: unknown; anonymous?: boolean; retry?: boolean } = {}
  ): Promise<T> {
    if (!options.anonymous && !this.accessToken) throw new MatrixError('Die Chat-Sitzung ist nicht verbunden.', 401);
    const method = options.method || 'GET';
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(!options.anonymous && this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const payload = (await response.json().catch(() => ({}))) as T & MatrixErrorBody;
    if (response.status === 429 && options.retry !== false) {
      await new Promise(resolve => setTimeout(resolve, Math.min(payload.retry_after_ms || 1000, 10000)));
      return this.request(path, { ...options, retry: false });
    }
    if (!response.ok) {
      throw new MatrixError(payload.error || `Der Chatserver antwortete mit HTTP ${response.status}.`, response.status, payload.errcode);
    }
    return payload;
  }

  private async loadDirectRooms(): Promise<Record<string, string[]>> {
    if (this.directRooms) return this.directRooms;
    if (this.directRoomsPromise) return this.directRoomsPromise;
    this.directRoomsPromise = (async () => {
      try {
        this.directRooms = await this.request<Record<string, string[]>>(
          `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent('m.direct')}`
        );
      } catch (error) {
        if (!(error instanceof MatrixError) || (error.status !== 404 && error.code !== 'M_NOT_FOUND')) throw error;
        this.directRooms = {};
      }
      return this.directRooms;
    })().finally(() => {
      this.directRoomsPromise = null;
    });
    return this.directRoomsPromise;
  }

  private async writeDirectRooms(): Promise<void> {
    await this.request(
      `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent('m.direct')}`,
      { method: 'PUT', body: this.directRooms || {} }
    );
  }

  private async createDirectRoom(recipientId: string): Promise<string> {
    const response = await this.request<{ room_id: string }>('/_matrix/client/v3/createRoom', {
      method: 'POST',
      body: { is_direct: true, preset: 'private_chat', visibility: 'private', invite: [recipientId] }
    });
    const directRooms = await this.loadDirectRooms();
    directRooms[recipientId] = [...new Set([...(directRooms[recipientId] || []), response.room_id])];
    this.directWriteQueue = this.directWriteQueue.then(() => this.writeDirectRooms());
    await this.directWriteQueue;
    return response.room_id;
  }

  private async roomFor(recipientId: string): Promise<string> {
    const pending = this.roomPromises.get(recipientId);
    if (pending) return pending;
    const promise = (async () => {
      const directRooms = await this.loadDirectRooms();
      return directRooms[recipientId]?.[0] || this.createDirectRoom(recipientId);
    })().finally(() => this.roomPromises.delete(recipientId));
    this.roomPromises.set(recipientId, promise);
    return promise;
  }

  async sendText(recipientId: string, body: string): Promise<void> {
    let roomId = await this.roomFor(recipientId);
    const send = () =>
      this.request(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(crypto.randomUUID())}`,
        { method: 'PUT', body: { msgtype: 'm.text', body } }
      );
    try {
      await send();
    } catch (error) {
      if (!(error instanceof MatrixError) || ![403, 404].includes(error.status)) throw error;
      roomId = await this.createDirectRoom(recipientId);
      await send();
    }
  }
}
