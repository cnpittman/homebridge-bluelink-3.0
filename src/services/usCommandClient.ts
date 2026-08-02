import { Logger } from 'homebridge';
import AmericanVehicle from 'bluelinky/dist/vehicles/american.vehicle';
import { VehicleStartOptions } from 'bluelinky/dist/interfaces/common.interfaces';

// Hyundai's US backend accepts a lock/unlock/start/stop request and returns
// 200 immediately, but that only means the request was queued - not that the
// vehicle executed it. bluelinky's US vehicle methods treat that 200 as final
// success, and on newer vehicles the command is then never carried out at
// all: confirmed on a 2026 Sonata Hybrid, where a request byte-for-byte
// equivalent to bluelinky's returns 200 and the doors never move, while the
// official app works normally.
//
// The difference turned out to be the headers. bluelinky sends the token and
// PIN as 'access_token' and 'bluelinkservicepin' and omits clientSecret
// entirely, while Hyundai's own web client - and the actively maintained
// Python implementation that tracks it, HyundaiBlueLinkApiUSA.py in
// Hyundai-Kia-Connect/hyundai_kia_connect_api - sends 'accessToken',
// 'blueLinkServicePin' and 'clientSecret', with a JSON body rather than a
// form-encoded one. A PIN the backend does not recognise is consistent with
// what we saw: the request authenticates and queues, but the command itself
// is never authorised, so the vehicle ignores it.
//
// So this client mirrors that Python implementation rather than bluelinky
// for the four commands. Status reads still go through bluelinky, which
// works fine.
const CLIENT_ID = 'm66129Bb-em93-SPAHYN-bZ91-am4540zp19920';
const CLIENT_SECRET = 'v558o935-6nne-423i-baa8';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/75.0.3770.142 Safari/537.36';

// Confirmation cannot be done by polling. Hyundai's backend tracks a single
// outstanding remote request per vehicle - while a command is queued, any
// other remote request is refused (the official app surfaces this as
// "a previous request is pending [HT_533]"). A forced status refresh is
// itself a remote request, so refreshing while the command is in flight just
// returns the cached, pre-command reading. Polling therefore reports "not
// confirmed" no matter what the vehicle actually did, and each poll adds
// load for nothing.
//
// So: send the command, let HomeKit go, and ask the vehicle for a genuinely
// fresh status once the command has had time to clear the queue.
const CONFIRM_DELAY_MS = 90000;

// Following a transaction is a backend query, not a vehicle wake, so it can
// be polled at a normal rate without competing with the command itself.
const TRANSACTION_POLL_MS = 5000;
const TRANSACTION_TIMEOUT_MS = 120000;

interface RawVehicleStatus {
  doorLock?: boolean;
  engine?: boolean;
}

export class CommandFailedError extends Error {}

export class UsCommandClient {
  private generation?: string;

  constructor(
    private readonly vehicle: AmericanVehicle,
    private readonly log: Logger,
  ) {}

  // The 'gen' header tells Hyundai which telematics generation to dispatch a
  // command to. bluelinky does not read the real value - its US controller
  // derives it as `modelYear > 2016 ? '2' : '1'`, a rule from when gen 2 was
  // current, so every recent vehicle is announced as gen 2. The backend
  // accepts the command anyway and queues it against the wrong generation,
  // where it sits PENDING forever because the vehicle never answers on that
  // path. Status reads are unaffected, which is why they always worked.
  //
  // Hyundai reports the real value as 'vehicleGeneration' in the enrollment
  // details, so use that and fall back to bluelinky's guess only if it cannot
  // be read. (bluelinky's Canadian controller does read the real value.)
  private async getGeneration(): Promise<string> {
    if (this.generation) {
      return this.generation;
    }

    const fallback = this.vehicle.vehicleConfig.generation;
    try {
      const username = this.vehicle.userConfig.username ?? '';
      const response = await this.request(
        'GET',
        `enrollment/details/${encodeURIComponent(username)}`,
        undefined,
        undefined,
        fallback,
      );
      const text = await safeText(response);
      const entries = JSON.parse(text)?.enrolledVehicleDetails ?? [];

      for (const entry of entries) {
        const details = entry?.vehicleDetails;
        if (details?.vin === this.vehicle.vehicleConfig.vin) {
          const reported = details?.vehicleGeneration;
          if (reported) {
            this.generation = String(reported);
            if (this.generation !== fallback) {
              this.log.info(
                `Vehicle reports telematics generation ${this.generation}, ` +
                  `not the ${fallback} bluelinky assumes - using ${this.generation} ` +
                  'for commands',
              );
            }
            return this.generation;
          }
        }
      }
      this.log.warn(
        'Enrollment details did not report a generation for this vehicle - ' +
          `falling back to ${fallback}`,
      );
    } catch (error) {
      this.log.warn(
        `Could not read telematics generation, falling back to ${fallback}`,
        error,
      );
    }

    this.generation = fallback;
    return this.generation;
  }

  lock(onAccepted?: () => void): Promise<void> {
    return this.executeAndConfirm(
      'Lock',
      'rcs/rdo/off',
      this.vinBody(),
      refresh => this.doorLockIs(true, refresh),
      { onAccepted, appCloudVin: true },
    );
  }

  unlock(onAccepted?: () => void): Promise<void> {
    return this.executeAndConfirm(
      'Unlock',
      'rcs/rdo/on',
      this.vinBody(),
      refresh => this.doorLockIs(false, refresh),
      { onAccepted, appCloudVin: true },
    );
  }

  start(
    options: VehicleStartOptions,
    onAccepted?: () => void,
  ): Promise<void> {
    const merged = {
      airCtrl: false,
      airTempvalue: 70,
      defrost: false,
      heating1: false,
      ...options,
    };
    // Config may leave this out even though bluelinky types it as required.
    const igniOnDuration = merged.igniOnDuration ?? 5;
    const body = {
      Ims: 0,
      airCtrl: +merged.airCtrl,
      airTemp: { unit: 1, value: merged.airTempvalue },
      defrost: merged.defrost,
      heating1: +merged.heating1,
      igniOnDuration,
      // Sent as an object rather than bluelinky's null - this mirrors the
      // shape the working Python implementation sends.
      seatHeaterVentInfo: {
        drvSeatHeatState: 0,
        astSeatHeatState: 0,
        rlSeatHeatState: 0,
        rrSeatHeatState: 0,
      },
      username: this.vehicle.userConfig.username,
      vin: this.vehicle.vehicleConfig.vin,
    };
    return this.executeAndConfirm(
      'Start',
      'rcs/rsc/start',
      body,
      refresh => this.engineIs(true, refresh),
      { onAccepted },
    );
  }

  stop(onAccepted?: () => void): Promise<void> {
    return this.executeAndConfirm(
      'Stop',
      'rcs/rsc/stop',
      undefined,
      refresh => this.engineIs(false, refresh),
      { onAccepted },
    );
  }

  private vinBody(): Record<string, unknown> {
    return {
      userName: this.vehicle.userConfig.username,
      vin: this.vehicle.vehicleConfig.vin,
    };
  }

  private async executeAndConfirm(
    label: string,
    path: string,
    body: Record<string, unknown> | undefined,
    isConfirmed: (refresh: boolean) => Promise<boolean>,
    options: {
      onAccepted?: () => void;
      appCloudVin?: boolean;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<void> {
    const extraHeaders = { ...options.extraHeaders };
    if (options.appCloudVin) {
      extraHeaders['APPCLOUD-VIN'] = this.vehicle.vehicleConfig.vin;
    }

    extraHeaders['REFRESH'] = 'false';

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
    this.log.debug(
      `${label} accepted, response ${response.status}`,
      responseText,
      JSON.stringify(Object.fromEntries(response.headers.entries())),
    );

    // Tell HomeKit the command went through as soon as Hyundai accepts it.
    // HomeKit gives a characteristic handler roughly ten seconds before it
    // gives up and shows "No Response", but the vehicle routinely takes far
    // longer than that to actually carry a command out - so holding the
    // callback until confirmation guaranteed "No Response" no matter what
    // the car did. Verification continues in the background and corrects the
    // reported state once the vehicle really reports in.
    options.onAccepted?.();

    // Hyundai returns a transaction id for the queued command and will report
    // what became of it, which is the only direct answer to "did the vehicle
    // actually do this". Fall back to reading vehicle state if the response
    // carried no transaction id.
    const transactionId = extractTransactionId(response);
    if (transactionId) {
      this.log.debug(`${label} transaction id: ${transactionId}`);
      await this.followTransaction(label, transactionId);
      return;
    }

    this.log.warn(
      `${label} response carried no transaction id, so Hyundai cannot be ` +
        'asked what became of it - falling back to reading vehicle state',
    );
    await this.verifyAfterSettling(label, isConfirmed);
  }

  // Asks Hyundai what happened to a queued command. This is the same
  // rmt/getRunningStatus endpoint the maintained Python implementation polls;
  // bluelinky has no equivalent. Unlike a forced status refresh, it queries
  // the backend about the transaction rather than waking the vehicle, so it
  // is not refused while the command is still pending.
  private async followTransaction(
    label: string,
    transactionId: string,
  ): Promise<void> {
    const deadline = Date.now() + TRANSACTION_TIMEOUT_MS;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt += 1;
      await sleep(TRANSACTION_POLL_MS);

      const response = await this.request(
        'GET',
        'rmt/getRunningStatus',
        undefined,
        {
          tid: transactionId,
          login_id: this.vehicle.userConfig.username ?? '',
          service_type: 'REMOTE_POLL',
          REFRESH: 'false',
        },
      );
      const text = await safeText(response);
      this.log.debug(
        `${label} transaction check ${attempt}: HTTP ${response.status}`,
        text,
      );

      let status: string | undefined;
      try {
        status = JSON.parse(text)?.status;
      } catch {
        // Body was not JSON - already logged above, keep waiting.
      }

      if (status === 'SUCCESS') {
        this.log.info(`${label} confirmed complete by vehicle`);
        return;
      }
      if (status === 'ERROR') {
        this.log.error(
          `${label} was rejected by the vehicle or the backend`,
          text,
        );
        return;
      }
    }

    this.log.warn(
      `${label} still pending after ${Math.round(TRANSACTION_TIMEOUT_MS / 1000)}s ` +
        '- the vehicle has not acknowledged it',
    );
  }

  private async verifyAfterSettling(
    label: string,
    isConfirmed: (refresh: boolean) => Promise<boolean>,
  ): Promise<void> {
    await sleep(CONFIRM_DELAY_MS);

    const confirmed = await isConfirmed(true);
    if (confirmed) {
      this.log.info(`${label} confirmed complete by vehicle`);
    } else {
      this.log.warn(
        `${label} not reflected in vehicle status - it may still be in ` +
          'progress, or the vehicle may not have carried it out',
      );
    }
  }

  private async doorLockIs(locked: boolean, refresh: boolean): Promise<boolean> {
    const status = await this.fetchVehicleStatus(refresh);
    return status?.doorLock === locked;
  }

  private async engineIs(on: boolean, refresh: boolean): Promise<boolean> {
    const status = await this.fetchVehicleStatus(refresh);
    return status !== undefined && !!status.engine === on;
  }

  private async fetchVehicleStatus(
    refresh: boolean,
  ): Promise<RawVehicleStatus | undefined> {
    const response = await this.request(
      'GET',
      'rcs/rvs/vehicleStatus',
      undefined,
      { REFRESH: refresh ? 'true' : 'false' },
    );
    const text = await safeText(response);
    try {
      return JSON.parse(text)?.vehicleStatus;
    } catch {
      this.log.warn('Failed to parse vehicle status response', text);
      return undefined;
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    extraHeaders?: Record<string, string>,
    // Set only by the enrollment lookup itself, which cannot wait on the
    // generation it is in the process of resolving.
    knownGeneration?: string,
  ): Promise<Response> {
    await this.vehicle.controller.refreshAccessToken();

    const generation = knownGeneration ?? (await this.getGeneration());
    const headers = { ...this.getHeaders(generation), ...extraHeaders };
    const url = `${this.vehicle.controller.environment.baseUrl}/ac/v2/${path}`;
    this.log.debug(
      `${method} ${url}`,
      JSON.stringify(redactHeaders(headers)),
      body ? JSON.stringify(body) : '',
    );

    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private getHeaders(generation: string): Record<string, string> {
    const { controller, vehicleConfig, userConfig } = this.vehicle;
    const origin = `https://${controller.environment.host}`;

    // Deliberately no 'Host' header: undici sets it from the URL and
    // rejects attempts to override it. Everything else mirrors the header
    // set the working Python implementation sends.
    return {
      'content-type': 'application/json;charset=UTF-8',
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT,
      'origin': origin,
      'referer': `${origin}/login`,
      'from': 'SPA',
      'to': 'ISS',
      'language': '0',
      'offset': `${localUtcOffsetHours()}`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      // No lowercase 'refresh' default here. HTTP header names are case
      // insensitive, so pairing it with the 'REFRESH' the status call adds
      // makes fetch collapse the two into "false, true" and the refresh is
      // silently lost. Callers set REFRESH explicitly instead.
      'encryptFlag': 'false',
      'brandIndicator': vehicleConfig.brandIndicator,
      'client_id': CLIENT_ID,
      'clientSecret': CLIENT_SECRET,
      'username': userConfig.username ?? '',
      'accessToken': controller.session.accessToken ?? '',
      'blueLinkServicePin': userConfig.pin ?? '',
      'registrationId': vehicleConfig.regId,
      'gen': generation,
      'vin': vehicleConfig.vin,
    };
  }
}

// Hyundai expects the caller's UTC offset in whole hours. bluelinky hardcodes
// -5, which is wrong for half the year and for anyone outside US Eastern.
function localUtcOffsetHours(): number {
  return -Math.round(new Date().getTimezoneOffset() / 60);
}

function extractTransactionId(response: Response): string | undefined {
  for (const key of ['tmsTid', 'transactionId', 'Xid']) {
    const value = response.headers.get(key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = { ...headers };
  for (const key of ['accessToken', 'blueLinkServicePin', 'clientSecret']) {
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
