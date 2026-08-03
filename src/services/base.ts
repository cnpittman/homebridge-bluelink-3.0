import { VehicleStatus } from 'bluelinky/dist/interfaces/common.interfaces';
import { Vehicle } from 'bluelinky/dist/vehicles/vehicle';
import { Characteristic, Logger, PlatformAccessory, Service } from 'homebridge';
import { HyundaiConfig } from '../config';
import { HyundaiPlatform } from '../platform';
import { VehicleAccessory } from '../platformAccessory';
import { UsCommandClient } from './usCommandClient';

export abstract class HyundaiService {
  protected readonly accessory: PlatformAccessory;
  protected readonly vehicle: Vehicle;
  protected readonly platform: HyundaiPlatform;
  protected readonly Characteristic: typeof Characteristic;
  protected readonly log: Logger;
  protected readonly config: HyundaiConfig;

  constructor(protected readonly va: VehicleAccessory) {
    this.accessory = this.va.accessory;
    this.vehicle = this.va.vehicle;
    this.platform = this.va.platform;
    this.Characteristic = this.platform.Characteristic;
    this.log = this.platform.log;
    this.config = <HyundaiConfig>this.platform.config;
    // Contain failures to the service that caused them. EventEmitter
    // propagates a throwing listener synchronously, so without this a single
    // bad reading would stop the remaining services from seeing the update at
    // all, and would surface inside the status fetch's own catch - logged as
    // a fetch failure and backing polling off for up to an hour.
    this.va.on('update', (status: VehicleStatus) => {
      try {
        this.setCurrentState(status);
      } catch (error) {
        this.log.error(`Failed to apply status update to ${this.name}`, error);
      }
    });
  }

  // bluelinky's US command methods (lock/unlock/start/stop) return success as
  // soon as Hyundai's backend accepts the request into its queue - they never
  // confirm the vehicle actually executed it. On newer vehicles that leaves
  // the command stuck "pending" instead of taking effect. For the US region
  // only, route commands through UsCommandClient instead, which polls for
  // real completion. Other regions keep using bluelinky's built-in methods.
  //
  // Held on the vehicle rather than per service, so the lock and the ignition
  // share one telematics-generation lookup instead of each performing (and
  // caching) their own.
  protected get usCommandClient(): UsCommandClient | undefined {
    return this.va.usCommandClient;
  }

  protected get service(): Service {
    return (
      this.accessory.getService(this.name) ||
      this.accessory.addService(
        this.platform.Service[this.serviceType],
        this.name,
        this.name,
      )
    );
  }

  abstract name: string;
  abstract serviceType: string;
  abstract initService(): void;
  abstract setCurrentState(status: VehicleStatus): void;
}

// Commands acknowledge HomeKit as soon as the request is accepted and then
// keep confirming in the background, so the success and failure paths can
// both end up calling back. HomeKit throws if a characteristic callback fires
// twice, so make sure only the first one counts.
export function once(cb): (reason?) => void {
  let called = false;
  return reason => {
    if (called) {
      return;
    }
    called = true;
    cb(reason ?? null);
  };
}
