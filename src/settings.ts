/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
// Keep this as 'Hyundai'. It is shared with the plugin this was forked from,
// which is not ideal, but renaming it in 3.0.0 broke working installs: the
// platform name is half the key Homebridge matches cached accessories
// against, so changing it orphans every cached accessory and the child
// bridge died on startup. Not worth it to avoid a collision with a plugin
// that has to be installed alongside this one to matter at all.
export const PLATFORM_NAME = 'Hyundai';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-bluelink-3-0';
