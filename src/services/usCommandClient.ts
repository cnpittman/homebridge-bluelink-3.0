import { Logger } from 'homebridge';
import AmericanVehicle from 'bluelinky/dist/vehicles/american.vehicle';
import { RequestHeaders } from 'bluelinky/dist/interfaces/american.interfaces';
import { VehicleStartOptions } from 'bluelinky/dist/interfaces/common.interfaces';

// Hyundai's US backend accepts a lock/unlock/start/stop request and returns
// 200 immediately, but that only means the command was queued - not that the
// vehicle executed it. bluelinky's US vehicle methods treat that 200 as final
// success, which on newer vehicles leaves the command stuck "pending" on
// Hyundai's side. This client fires the same requests bluelinky does (lock/
// unlock as a form-encoded body, exactly as bluelinky's american.vehicle
// does - Hyundai's API silently no-ops those two if sent as JSON), then polls
// the same rcs/rvs/vehicleStatus endpoint bluelinky's own status() call uses
// until the door lock / ignition state actually reflects the command, before
// reporting success back to HomeKit.
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;

type RequestBody = { json: Record<string, unknown> } | { form: string };

interface RawVehicleStatus {
  doorLock?: boolean;
  engine?: boolean;
}

export class CommandFailedError extends Error {}

export class UsCommandClient {
  constructor(
    private readonly vehicle: AmericanVehicle,
    private readonly log: Logger,
  ) {}

  lock(): Promise<void> {
    return this.executeAndConfirm('Lock', 'rcs/rdo/off', this.vinForm(), () =>
      this.doorLockIs(true),
    );
  }

  unlock(): Promise<void> {
    return this.executeAndConfirm('Unlock', 'rcs/rdo/on', this.vinForm(), () =>
      this.doorLockIs(false),
    );
  }

  start(options: VehicleStartOptions): Promise<void> {
    const merged = {
      airCtrl: false,
      airTempvalue: 70,
      defrost: false,
      heating1: false,
      ...options,
    };
    const body = {
      Ims: 0,
      airCtrl: +merged.airCtrl,
      airTemp: { unit: 1, value: `${merged.airTempvalue}` },
      defrost: merged.defrost,
      heating1: +merged.heating1,
      igniOnDuration: merged.igniOnDuration,
      seatHeaterVentInfo: null,
      username: this.vehicle.userConfig.username,
      vin: this.vehicle.vehicleConfig.vin,
    };
    return this.executeAndConfirm(
      'Start',
      'rcs/rsc/start',
      { json: body },
      () => this.engineIs(true),
      // bluelinky overrides the UTC offset header specifically for start.
      { offset: '-4' },
    );
  }

  stop(): Promise<void> {
    return this.executeAndConfirm('Stop', 'rcs/rsc/stop', undefined, () =>
      this.engineIs(false),
    );
  }

  private vinForm(): RequestBody {
    const params = new URLSearchParams();
    params.append('userName', this.vehicle.userConfig.username ?? '');
    params.append('vin', this.vehicle.vehicleConfig.vin);
    return { form: params.toString() };
  }

  private async executeAndConfirm(
    label: string,
    path: string,
    body: RequestBody | undefined,
    isConfirmed: () => Promise<boolean>,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
    const response = await this.request('POST', path, body, extraHeaders);
    const responseText = await safeText(response);

    if (!response.ok) {
      this.log.error(
        `${label} request rejected with status ${response.status}`,
        responseText,
      );
      throw new CommandFailedError(
        `${label} request rejected with status ${response.status}`,
      );
    }
    this.log.debug(`${label} accepted, response ${response.status}`, responseText);

    await this.pollUntilConfirmed(label, isConfirmed);
  }

  private async pollUntilConfirmed(
    label: string,
    isConfirmed: () => Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt += 1;
      await sleep(POLL_INTERVAL_MS);

      const confirmed = await isConfirmed();
      this.log.debug(
        `${label} poll attempt ${attempt}: ${confirmed ? 'confirmed' : 'not yet'}`,
      );

      if (confirmed) {
        this.log.info(`${label} confirmed complete by vehicle`);
        return;
      }
    }

    this.log.error(
      `${label} timed out after ${POLL_TIMEOUT_MS}ms waiting for the vehicle to confirm completion`,
    );
    throw new CommandFailedError(
      `${label} timed out waiting for vehicle confirmation`,
    );
  }

  private async doorLockIs(locked: boolean): Promise<boolean> {
    const status = await this.fetchVehicleStatus();
    return status?.doorLock === locked;
  }

  private async engineIs(on: boolean): Promise<boolean> {
    const status = await this.fetchVehicleStatus();
    return status !== undefined && !!status.engine === on;
  }

  private async fetchVehicleStatus(): Promise<RawVehicleStatus | undefined> {
    const response = await this.request('GET', 'rcs/rvs/vehicleStatus', undefined, {
      REFRESH: 'true',
    });
    const text = await safeText(response);
    try {
      return JSON.parse(text)?.vehicleStatus;
    } catch {
      this.log.warn('Failed to parse vehicle status response while polling', text);
      return undefined;
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: RequestBody | undefined,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    await this.vehicle.controller.refreshAccessToken();

    const headers: Record<string, string> = {
      ...toStringHeaders(this.getHeaders()),
      ...extraHeaders,
    };

    let requestBody: string | undefined;
    if (body && 'json' in body) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body.json);
    } else if (body && 'form' in body) {
      // Matches bluelinky's own lock/unlock encoding - Hyundai's API expects
      // this as application/x-www-form-urlencoded, not JSON.
      requestBody = body.form;
    }

    const url = `${this.vehicle.controller.environment.baseUrl}/ac/v2/${path}`;
    this.log.debug(
      `${method} ${url}`,
      JSON.stringify(redactHeaders(headers)),
      requestBody ?? '',
    );

    return fetch(url, {
      method,
      headers,
      body: requestBody,
    });
  }

  private getHeaders(): RequestHeaders {
    const { controller, vehicleConfig, userConfig } = this.vehicle;
    return {
      'access_token': controller.session.accessToken,
      'client_id': controller.environment.clientId,
      'Host': controller.environment.host,
      'User-Agent': 'okhttp/3.12.0',
      'registrationId': vehicleConfig.regId,
      'gen': vehicleConfig.generation,
      'username': userConfig.username,
      'vin': vehicleConfig.vin,
      'APPCLOUD-VIN': vehicleConfig.vin,
      'Language': '0',
      'to': 'ISS',
      'encryptFlag': 'false',
      'from': 'SPA',
      'brandIndicator': vehicleConfig.brandIndicator,
      'bluelinkservicepin': userConfig.pin,
      'offset': '-5',
    };
  }
}

function toStringHeaders(headers: RequestHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = { ...headers };
  for (const key of ['access_token', 'bluelinkservicepin']) {
    if (redacted[key]) {
      redacted[key] = '***redacted***';
    }
  }
  return redacted;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
