import { HyundaiService, once } from './base';
import { VehicleStatus } from 'bluelinky/dist/interfaces/common.interfaces';

export class Ignition extends HyundaiService {
  private isOn?: boolean;
  private _shouldTurnOn?: boolean;
  private resetTimer?: NodeJS.Timeout;
  private commandInFlight = false;
  name = 'Ignition';
  serviceType = 'Switch';

  initService(): void {
    const { On } = this.Characteristic;
    this.service
      ?.getCharacteristic(On)
      .on('get', cb => cb(null, this.isOn ?? false))
      .on('set', (value, cb) => {
        // Do exactly what HomeKit asked for. This used to ignore the
        // requested value and toggle the current state instead, so switching
        // off while the engine already read as off computed the opposite and
        // remote started the car.
        const shouldTurnOn = !!value;

        // Hyundai only tracks one outstanding remote request per vehicle, so
        // a second command while one is in flight would just be refused.
        // Note this must still call back - the previous guard returned
        // without calling cb, which left HomeKit waiting until it gave up
        // and showed "No Response".
        if (this.commandInFlight) {
          this.log.info(
            `Ignoring ${shouldTurnOn ? 'start' : 'stop'} - a command is ` +
              'already in progress for this vehicle',
          );
          cb(null);
          return;
        }

        this.shouldTurnOn = shouldTurnOn;
        if (shouldTurnOn) {
          this.start(cb);
        } else {
          this.stop(cb);
        }
      });
  }
  start(cb): void {
    this.log.info('Starting Vehicle');
    const respond = once(cb);
    this.commandInFlight = true;

    if (this.usCommandClient) {
      this.usCommandClient
        .start(this.config.remoteStart, () => respond(null))
        // usCommandClient already forced one refresh while confirming, so
        // read Hyundai's cache here rather than waking the car again.
        .then(() => this.va.fetchStatus(false))
        .catch(reason => {
          this.log.error('Start Fail', reason);
          respond(reason);
        })
        .finally(() => {
          this.commandInFlight = false;
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
      })
      .finally(() => {
        this.commandInFlight = false;
      });
  }
  stop(cb): void {
    this.log.info('Stopping Vehicle');
    const respond = once(cb);
    this.commandInFlight = true;

    if (this.usCommandClient) {
      this.usCommandClient
        .stop(() => respond(null))
        .then(() => this.va.fetchStatus(false))
        .catch(reason => {
          this.log.error('Stop Fail', reason);
          respond(reason);
        })
        .finally(() => {
          this.commandInFlight = false;
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
      })
      .finally(() => {
        this.commandInFlight = false;
      });
  }

  setCurrentState(status: VehicleStatus): void {
    const changed = status.engine.ignition !== this.isOn;
    if (changed) {
      this.isOn = status.engine.ignition;
      this.log.info(`Vehicle is ${this.isOn ? 'On' : 'Off'}`);
    }

    // Leave the switch alone until the command resolves, otherwise a routine
    // status poll landing mid-command flips it back before the car has acted.
    if (this.commandInFlight) {
      return;
    }

    // Push even when the reading has not changed. A command the vehicle never
    // carried out leaves HomeKit showing the state that was requested, and
    // since the reading did not change there would otherwise be nothing to
    // correct it - the switch stays stuck on.
    const pending = this._shouldTurnOn;
    this._shouldTurnOn = undefined;
    if (changed || (pending !== undefined && pending !== !!this.isOn)) {
      // Coerce: the characteristic rejects undefined, which is what this
      // reads as before the first status arrives.
      this.service?.updateCharacteristic(this.Characteristic.On, !!this.isOn);
    }
  }
  get shouldTurnOn(): boolean | undefined {
    return this._shouldTurnOn;
  }
  set shouldTurnOn(value: boolean | undefined) {
    this._shouldTurnOn = value;
    // Check on status & reset after 1 minute. Replaces any timer already
    // pending rather than stacking another one per command.
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    this.resetTimer = setTimeout(() => {
      this.va.fetchStatus();
      this._shouldTurnOn = undefined;
      this.resetTimer = undefined;
    }, 1000 * 60);
  }
}
