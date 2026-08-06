import { HyundaiConfig } from '../config';
import { VehicleAccessory } from '../platformAccessory';
import { HyundaiService } from './base';
import { Lock } from './lock';
import { Motor } from './motor';
import { Ignition } from './ignition';
import { Range } from './range';

export default function (va: VehicleAccessory): void {
  const config = <HyundaiConfig>va.platform.config;
  const services: HyundaiService[] = [
    new Lock(va),
    new Motor(va),
    new Ignition(va),
  ];

  if (config.showRangeSensor) {
    services.push(new Range(va));
  } else {
    // Turning the option back off should take the tile away too - a cached
    // accessory keeps every service it was ever given until one is removed.
    const existing = va.accessory.getService('Range');
    if (existing) {
      va.platform.log.info('Removing the range sensor, showRangeSensor is off');
      va.accessory.removeService(existing);
    }
  }

  services.forEach(s => s.initService());
}
