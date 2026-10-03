export class RpcPool {
  primaryUrl: string;
  fallbackUrls: string[];
  currentUrl: string;
  failureCount: number = 0;
  rtt: number = 0;
  private healthCheckTimer: any;

  constructor(primaryUrl: string, fallbackUrls: string[]) {
    this.primaryUrl = primaryUrl;
    this.fallbackUrls = fallbackUrls;
    this.currentUrl = primaryUrl;
  }

  async fetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.currentUrl}${endpoint}`, options);
      this.rtt = Date.now() - start;

      if (response.status === 429 || response.status === 503) {
        this.handleFailure();
      } else {
        this.failureCount = 0;
      }
      return response;
    } catch (error) {
      this.handleFailure();
      throw error;
    }
  }

  private handleFailure() {
    this.failureCount++;
    if (this.failureCount >= 3) {
      this.failover();
    }
  }

  private failover() {
    this.failureCount = 0;
    const nextUrl = this.fallbackUrls.shift();
    if (nextUrl) {
      this.fallbackUrls.push(this.currentUrl);
      this.currentUrl = nextUrl;
    }
  }

  startHealthCheck(interval: number = 10000) {
    if (this.healthCheckTimer) clearTimeout(this.healthCheckTimer);
    this.healthCheckTimer = setTimeout(() => {
      this.fetch("/health").catch(() => {});
      this.startHealthCheck(interval);
    }, interval);
  }

  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
