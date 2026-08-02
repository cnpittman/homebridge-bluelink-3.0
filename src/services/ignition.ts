import { HyundaiService, once } from './base';
import { VehicleStatus } from 'bluelinky/dist/interfaces/common.interfaces';

export class Ignition extends HyundaiService {
  private isOn?: boolean;
  private _shouldTurnOn?: boolean;
  name = 'Ignition';
  serviceType = 'Switch';

  initService(): void {
    const { On } = this.Characteristic;
    this.service
      ?.getCharacteristic(On)
      .on('get', cb => cb(null, this.isOn ?? false))
      .on('set', (_value, cb) => {
        if (this.shouldTurnOn === undefined) {
          this.shouldTurnOn = !this.isOn;
          this.shouldTurnOn ? this.start(cb) : this.stop(cb);
        } else {
          this.log.debug('isOn', this.isOn);
          this.log.debug('shouldTurnOn', this.shouldTurnOn);
        }
      });
  }
  start(cb): void {
    this.log.info('Starting Vehicle');
    const respond = once(cb);

    if (this.usCommandClient) {
      this.usCommandClient
        .start(this.config.remoteStart, () => respond(null))
        // usCommandClient already forced one refresh while confirming, so
        // read Hyundai's cache here rather than waking the car again.
        .then(() => this.va.fetchStatus(false))
        .catch(reason => {
          this.log.error('Start Fail', reason);
          respond(reason);
        });
      return;
    }

    this.vehicle
      .start(this.config.remoteStart)
      .then(response => {
        this.log.info('Start Response', response);
        this.va.fetchStatus(true);
        respond(null);
      })
      .catch(reason => {
        this.log.error('Start Fail', reason);
        respond(reason);
      });
  }
  stop(cb): void {
    this.log.info('Stopping Vehicle');
    const respond = once(cb);

    if (this.usCommandClient) {
      this.usCommandClient
        .stop(() => respond(null))
        .then(() => this.va.fetchStatus(false))
        .catch(reason => {
          this.log.error('Stop Fail', reason);
          respond(reason);
        });
      return;
    }

    this.vehicle
      .stop()
      .then(response => {
        this.log.info('Stop Response', response);
        this.va.fetchStatus(true);
        respond(null);
      })
      .catch(reason => {
        this.log.error('Stop Fail', reason);
        respond(reason);
      });
  }

  setCurrentState(status: VehicleStatus): void {
    if (status.engine.ignition !== this.isOn) {
      this.isOn = status.engine.ignition;

      this.log.info(`Vehicle is ${this.isOn ? 'On' : 'Off'}`);
      this.service?.updateCharacteristic(this.Characteristic.On, this.isOn);
    }
  }
  get shouldTurnOn(): boolean | undefined {
    return this._shouldTurnOn;
  }
  set shouldTurnOn(value: boolean | undefined) {
    this._shouldTurnOn = value;
    // Check on status & reset after 1 minute
    setTimeout(() => {
      this.va.fetchStatus();
      this._shouldTurnOn = undefined;
    }, 1000 * 60);
  }
}
