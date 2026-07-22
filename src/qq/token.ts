export class QqAccessToken {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly appId: string,
    private readonly clientSecret: string,
  ) {}

  async getAuthorization(): Promise<string> {
    const token = await this.getToken();
    return `QQBot ${token}`;
  }

  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    // refresh 60s early
    if (this.accessToken && now < this.expiresAt - 60) {
      return this.accessToken;
    }
    await this.refresh();
    if (!this.accessToken) throw new Error("Failed to obtain QQ access_token");
    return this.accessToken;
  }

  invalidate(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  private async refresh(): Promise<void> {
    const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: string | number;
      message?: string;
      code?: number;
    };
    if (!res.ok || !data.access_token || data.expires_in == null) {
      throw new Error(`获取 access_token 失败: ${JSON.stringify(data)}`);
    }
    this.accessToken = data.access_token;
    this.expiresAt = Math.floor(Date.now() / 1000) + Number(data.expires_in);
    console.log(`[qq] access_token refreshed, expires_in=${data.expires_in}s`);
  }
}
