import { Logger } from 'homebridge';
import { HyundaiService, once } from './base';
import {
  VehicleStartOptions,
  VehicleStatus,
} from 'bluelinky/dist/interfaces/common.interfaces';

// Remote start runs for 1-10 minutes; the original plugin's README notes that
// anything outside that range makes the start fail. Its settings UI
// nonetheless defaulted the run time to 15, so a remote start configured with
// the defaults asked for a duration the vehicle would refuse.
const MIN_RUN_MINUTES = 1;
const MAX_RUN_MINUTES = 10;

export class Ignition extends HyundaiService {
  private isOn?: boolean;
  private _shouldTurnOn?: boolean;
  private resetTimer?: NodeJS.Timeout;
  private commandInFlight = false;
  private remoteStart?: VehicleStartOptions;
  name = 'Ignition';
  serviceType = 'Switch';

  initService(): void {
    const { On } = this.Characteristic;
    // Checked once here rather than on each start, so a bad value shows up
    // in the startup log instead of only when a start is attempted.
    this.remoteStart = sanitizeRemoteStart(this.config.remoteStart, this.log);
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
        .start(this.remoteStart, () => respond(null))
        // usCommandClient already forced one refresh while confirming, so
        // read Hyundai's cache here rather than waking the car again.
        .then(() => this.va.fetchStatus(false))
        .catch(reason => {
          this.log.error('Start Fail', reason);
          respond(reason);
        })
        .finally(() => this.commandFinished());
      return;
    }

    this.vehicle
      .start(this.remoteStart as VehicleStartOptions)
      .then(response => {
        this.log.info('Start Response', response);
        this.va.fetchStatus(true);
        respond(null);
      })
      .catch(reason => {
        this.log.error('Start Fail', reason);
        respond(reason);
      })
      .finally(() => this.commandFinished());
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
        .finally(() => this.commandFinished());
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
      .finally(() => this.commandFinished());
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

    this.settle(changed);
  }

  // Push even when the reading has not changed. A command the vehicle never
  // carried out leaves HomeKit showing the state that was requested, and
  // since the reading did not change there would otherwise be nothing to
  // correct it - the switch stays stuck on.
  private settle(changed = false): void {
    const pending = this._shouldTurnOn;
    this._shouldTurnOn = undefined;
    if (changed || (pending !== undefined && pending !== !!this.isOn)) {
      // Coerce: the characteristic rejects undefined, which is what this
      // reads as before the first status arrives.
      this.service?.updateCharacteristic(this.Characteristic.On, !!this.isOn);
    }
  }

  private commandFinished(): void {
    this.commandInFlight = false;
    // Start the reset over from here, so there is always one after the
    // command - the one armed when it was sent may have come and gone while
    // it was still in flight.
    this.scheduleReset();
  }

  get shouldTurnOn(): boolean | undefined {
    return this._shouldTurnOn;
  }
  set shouldTurnOn(value: boolean | undefined) {
    this._shouldTurnOn = value;
    this.scheduleReset();
  }

  // Check on status & reset after 1 minute. Replaces any timer already
  // pending rather than stacking another one per command.
  private scheduleReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined;
      // Commands routinely take longer than this to resolve. Clearing the
      // pending state underneath one left its completion nothing to compare
      // the vehicle's reading against, so a start the car never carried out
      // stayed showing On. commandFinished() re-arms this once it resolves.
      if (this.commandInFlight) {
        return;
      }
      this.settle();
      this.va.fetchStatus();
    }, 1000 * 60);
  }
}

// Bring the configured run time into the range remote start accepts, rather
// than sending a value the vehicle will refuse. Anything that isn't a number
// gets the longest run, matching what bluelinky uses when none is given.
function sanitizeRemoteStart(
  options: VehicleStartOptions | undefined,
  log: Logger,
): VehicleStartOptions | undefined {
  if (!options || options.igniOnDuration === undefined) {
    return options;
  }
  const requested = Number(options.igniOnDuration);
  const minutes = Number.isFinite(requested)
    ? Math.min(
        MAX_RUN_MINUTES,
        Math.max(MIN_RUN_MINUTES, Math.round(requested)),
      )
    : MAX_RUN_MINUTES;
  if (minutes !== requested) {
    log.warn(
      `remoteStart.igniOnDuration is ${options.igniOnDuration}, but remote ` +
        `start only runs for ${MIN_RUN_MINUTES}-${MAX_RUN_MINUTES} minutes - ` +
        `using ${minutes}. Change it in the plugin settings to silence this.`,
    );
  }
  return { ...options, igniOnDuration: minutes };
}
