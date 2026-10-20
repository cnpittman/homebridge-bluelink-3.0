import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import BlueLinky from 'bluelinky';
import { Vehicle } from 'bluelinky/dist/vehicles/vehicle';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { VehicleAccessory } from './platformAccessory';
import { HyundaiConfig } from './config';

// Backs off the same way status polling does: a minute, doubling to an hour.
const INITIAL_LOGIN_RETRY_MS = 1000 * 60;
const MAX_LOGIN_RETRY_MS = 1000 * 60 * 60;

export class HyundaiPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly config: HyundaiConfig;
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.config = <HyundaiConfig>config;
    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      try {
        this.discoverDevices();
      } catch (e) {
        log.error('discoverDevices Error', e);
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices(): void {
    // Never log credentials. This used to dump the whole config, which put
    // the account password and the PIN that authorises remote commands into
    // homebridge.log in plain text - and into any log a user shares when
    // asking for help.
    this.log.debug('Hyundai config:', redactCredentials(this.config));

    if (!this.config.credentials) {
      this.log.error(
        'No credentials configured - set them in the Homebridge UI or in ' +
          'config.json before this plugin can do anything.',
      );
      return;
    }
    if (!this.config.vehicles?.length) {
      this.log.error(
        'No vehicles configured - add at least one VIN before this plugin ' +
          'can do anything.',
      );
      return;
    }
    // bluelinky's US client only knows Hyundai's service - Kia runs a
    // separate one in the US - so this pairing otherwise dies on a bare
    // "Constructor kia is not managed". The schema still offers Kia, since
    // Canada and Europe do support it.
    if (
      this.config.credentials.region === 'US' &&
      this.config.credentials.brand === 'kia'
    ) {
      this.log.error(
        'Kia is not supported in the US region - only Hyundai is. Kia works ' +
          'in Canada and Europe.',
      );
      return;
    }

    const client = new BlueLinky(this.config.credentials);

    // bluelinky logs in exactly once, at construction. Until a login
    // succeeds the cached accessories are in HomeKit with no handlers behind
    // them, so a tap on the lock shows it locking while nothing is sent - and
    // without a retry that lasted until Homebridge restarted. The usual
    // trigger is a Pi that boots faster than the router after a power cut.
    let loginRetryMs = 0;
    const retryLogin = (reason: string): void => {
      loginRetryMs = loginRetryMs
        ? Math.min(loginRetryMs * 2, MAX_LOGIN_RETRY_MS)
        : INITIAL_LOGIN_RETRY_MS;
      this.log.warn(
        `${reason} - retrying in ${Math.round(loginRetryMs / 60000)} min`,
      );
      setTimeout(() => client.login(), loginRetryMs).unref?.();
    };

    client.on('ready', vehicles => {
      this.log.debug('Client Ready');
      // An account with no vehicles at all is not a state anyone configures
      // a VIN for, so treat it as a bad response and ask again rather than
      // concluding every configured vehicle has gone.
      if (!vehicles.length) {
        retryLogin('Hyundai returned no vehicles for this account');
        return;
      }
      // One vehicle failing must not stop the rest being set up. Errors
      // thrown in here would otherwise surface as unhandled rejections, since
      // this runs on an event callback.
      for (const { vin, maxRange } of this.config.vehicles) {
        try {
          this.setUpVehicle(client, vin, maxRange);
        } catch (e) {
          this.log.error(`Failed to set up vehicle ${vin}`, e);
        }
      }
    });
    client.on('error', err => {
      if (isLoginRejected(err)) {
        // Retrying cannot fix a wrong password, and repeated failed logins
        // against the account are best avoided.
        this.log.error(
          'Hyundai rejected the login - check the username, password and ' +
            'region, then restart Homebridge.',
          err,
        );
        return;
      }
      this.log.error('Client Error', err);
      retryLogin('Login failed');
    });

    const uuids = (<HyundaiConfig>this.config).vehicles?.map(({ vin }) =>
      this.api.hap.uuid.generate(vin),
    );
    for (const accessory of this.accessories) {
      if (!uuids?.includes(accessory.UUID)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
        this.log.info(
          'Removing existing accessory from cache:',
          accessory.displayName,
        );
      }
    }
  }

  private setUpVehicle(
    client: BlueLinky,
    vin: string,
    maxRange: number | undefined,
  ): void {
    const uuid = this.api.hap.uuid.generate(vin);
    const existingAccessory = this.accessories.find(
      accessory => accessory.UUID === uuid,
    );
    this.log.debug('Fetching vehicle:', vin);
    const vehicle = findVehicle(client, vin);
    this.log.debug('Vehicle found', vehicle?.vehicleConfig);

    if (!vehicle) {
      if (existingAccessory) {
        // Keep it. This used to unregister the accessory, which deletes it
        // from HomeKit along with its room, scenes and automations - far too
        // much to hang on one response from Hyundai. Taking the VIN out of
        // the config still removes it - see the end of discoverDevices.
        this.log.warn(
          `Vehicle ${vin} was not on the account - leaving its accessory in ` +
            'HomeKit without controls. Remove the VIN from the config to ' +
            'delete it.',
        );
      } else {
        this.log.warn('Vehicle not found', vin);
      }
      return;
    }

    if (existingAccessory) {
      this.log.info(
        'Restoring existing accessory from cache:',
        existingAccessory.displayName,
      );
      existingAccessory.context.device = vehicle.vehicleConfig;
      existingAccessory.context.device.maxRange = maxRange;
      // create the accessory handler for the restored accessory
      // this is imported from `platformAccessory.ts`
      new VehicleAccessory(this, existingAccessory, vehicle);
      // update accessory cache with any changes to the accessory details and information
      this.api.updatePlatformAccessories([existingAccessory]);
      return;
    }

    // the accessory does not yet exist, so we need to create it
    this.log.info('Adding new accessory:', vehicle.nickname());

    // create a new accessory
    const accessory = new this.api.platformAccessory(vehicle.nickname(), uuid);

    // store a copy of the device object in the `accessory.context`
    // the `context` property can be used to store any data about the accessory you may need
    accessory.context.device = vehicle.vehicleConfig;
    accessory.context.device.maxRange = maxRange;

    // create the accessory handler for the newly create accessory
    // this is imported from `platformAccessory.ts`
    new VehicleAccessory(this, accessory, vehicle);

    // link the accessory to your platform
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
  }
}

// bluelinky's getVehicle throws when the account has vehicles but not this
// one, rather than returning undefined as its signature says. Thrown inside
// the setup loop, that stopped every vehicle listed after a mistyped VIN.
function findVehicle(client: BlueLinky, vin: string): Vehicle | undefined {
  try {
    return client.getVehicle(vin);
  } catch {
    return undefined;
  }
}

// A 4xx from the login endpoint means Hyundai refused the credentials;
// anything else (no network, DNS, a 5xx, a timeout, rate limiting) can clear
// up by itself.
// bluelinky wraps the HTTP error, so the status is on the original.
function isLoginRejected(error: unknown): boolean {
  const status = (error as { source?: { statusCode?: number } })?.source
    ?.statusCode;
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

function redactCredentials(config: HyundaiConfig): HyundaiConfig {
  const { credentials } = config;
  if (!credentials) {
    return config;
  }
  return {
    ...config,
    credentials: {
      ...credentials,
      password: '***redacted***',
      pin: '***redacted***',
    },
  };
}
