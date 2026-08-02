import { HyundaiService, once } from './base';
import { VehicleStatus } from 'bluelinky/dist/interfaces/common.interfaces';

export class Lock extends HyundaiService {
  private _shouldLock?: boolean;
  private isLocked?: boolean;
  private resetTimer?: NodeJS.Timeout;
  name = 'Doors';
  serviceType = 'LockMechanism';

  initService(): void {
    const { LockCurrentState, LockTargetState } = this.Characteristic;

    this.service
      ?.getCharacteristic(LockCurrentState)
      .on('get', cb => cb(null, this.lockCurrentState));

    this.service
      ?.getCharacteristic(LockTargetState)
      .on('get', cb => cb(null, this.lockTargetState))
      .on('set', (_value, cb) => {
        if ([undefined, this.isLocked].includes(this.shouldLock)) {
          this.shouldLock = !this.isLocked;
          this.shouldLock ? this.lock(cb) : this.unlock(cb);
        } else {
          this.log.debug('isLocked', this.isLocked);
          this.log.debug('shouldLock', this.shouldLock);
        }
      });
  }
  setCurrentState(status: VehicleStatus): void {
    if (status.chassis.locked !== this.isLocked) {
      this.isLocked = status.chassis.locked;
      this.log.info(`Vehicle is ${this.isLocked ? 'Locked' : 'Unlocked'}`);
      this.service?.updateCharacteristic(
        this.Characteristic.LockCurrentState,
        this.lockCurrentState,
      );
    }

    // Settle the target state onto whatever the vehicle actually reports.
    // HomeKit renders a lock whose target disagrees with its current state as
    // permanently "Locking..."/"Unlocking..." with a spinner, so a command the
    // vehicle never carried out would otherwise spin forever.
    if (this._shouldLock !== undefined && this._shouldLock !== this.isLocked) {
      this.log.debug(
        `Vehicle reports ${this.isLocked ? 'locked' : 'unlocked'} but ` +
          `${this._shouldLock ? 'lock' : 'unlock'} was requested - ` +
          'reverting the target state HomeKit shows',
      );
    }
    this._shouldLock = undefined;
    this.service?.updateCharacteristic(
      this.Characteristic.LockTargetState,
      this.lockTargetState,
    );
  }
  lock(cb): void {
    this.log.info('Locking Vehicle');
    const respond = once(cb);

    if (this.usCommandClient) {
      this.usCommandClient
        .lock(() => respond(null))
        // usCommandClient already forced one refresh while confirming, so
        // read Hyundai's cache here rather than waking the car again.
        .then(() => this.va.fetchStatus(false))
        .catch(reason => {
          this.log.error('Lock Fail', reason);
          respond(reason);
        });
      return;
    }

    this.vehicle
      .lock()
      .then(response => {
        this.log.info('Lock Response', response);
        this.va.fetchStatus(true);
        respond(null);
      })
      .catch(reason => {
        this.log.error('Lock Fail', reason);
        respond(reason);
      });
  }
  unlock(cb): void {
    this.log.info('Unlocking Vehicle');
    const respond = once(cb);

    if (this.usCommandClient) {
      this.usCommandClient
        .unlock(() => respond(null))
        .then(() => this.va.fetchStatus(false))
        .catch(reason => {
          this.log.error('Unlock Fail', reason);
          respond(reason);
        });
      return;
    }

    this.vehicle
      .unlock()
      .then(response => {
        this.log.info('Unlock Response', response);
        this.va.fetchStatus(true);
        respond(null);
      })
      .catch(reason => {
        this.log.error('Unlock Fail', reason);
        respond(reason);
      });
  }
  get lockCurrentState(): number {
    const { LockCurrentState } = this.Characteristic;

    if (this.isLocked) {
      return LockCurrentState.SECURED;
    } else if (this.isLocked === false) {
      return LockCurrentState.UNSECURED;
    } else {
      return LockCurrentState.UNKNOWN;
    }
  }
  get lockTargetState(): number {
    const { LockTargetState } = this.Characteristic;

    return this.shouldLock
      ? LockTargetState.SECURED
      : LockTargetState.UNSECURED;
  }
  get shouldLock(): boolean {
    return this._shouldLock === undefined ? !!this.isLocked : this._shouldLock;
  }
  set shouldLock(value: boolean) {
    this._shouldLock = value;
    // Check on status & reset after 1 minute. This has to be a timeout, not
    // an interval - an interval here is never cleared, so every lock/unlock
    // leaks another timer that polls Hyundai's API once a minute for as long
    // as Homebridge runs (the intended refresh rate is once an hour).
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    this.resetTimer = setTimeout(() => {
      this.va.fetchStatus();
      this._shouldLock = undefined;
      this.resetTimer = undefined;
    }, 1000 * 60);
  }
}
