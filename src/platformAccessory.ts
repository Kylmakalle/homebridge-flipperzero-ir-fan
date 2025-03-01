import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ExampleHomebridgePlatform } from './platform.js';
import { SerialPort } from 'serialport';
import { DEBOUNCE_TIME, IR_FILE_PATH, MEDIUM_THRESHOLD, HIGH_THRESHOLD, RECONNECT_INTERVAL, IR_SIGNAL_SEND_TRIES } from './settings.js';
import fs from 'fs';
import { Mutex } from 'async-mutex';

interface AccessoryStateUpdate {
  On?: boolean;
  Speed?: number;
}

interface AccessoryUpdateDebouncer {
  [key: string]: NodeJS.Timeout | undefined;
  On?: NodeJS.Timeout;
  Speed?: NodeJS.Timeout;
}

export class ExamplePlatformAccessory {
  private service: Service;
  private serialPort: SerialPort | null = null;
  private serialPortName: string;
  private irSignals: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  private updateDebouncers: AccessoryUpdateDebouncer = {};
  private reconnectInterval: NodeJS.Timeout | null = null;

  private mutex = new Mutex();

  private accessoryState: { [key: string]: boolean | number } = {
    On: false,
    Speed: 0,
  };

  private previousState: { [key: string]: boolean | number } = {
    On: false,
    Speed: 0,
  };

  constructor(
    private readonly platform: ExampleHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    serialPortName: string,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    this.service = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.exampleDisplayName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setSpeed.bind(this))
      .onGet(this.getSpeed.bind(this));

    // Initialize SerialPort and parse IR file
    this.irSignals = this.parseIRFile(IR_FILE_PATH);
    this.serialPortName = serialPortName;
    this.initializeSerialPort();

    // Initialize accessory state from context
    if (this.accessory.context.state) {
      this.accessoryState = this.accessory.context.state;
      this.previousState = { ...this.accessoryState };
    }
  }

  private buffer: string = '';

  // Serial port
  private initializeSerialPort() {
    if (this.serialPort) {
      try {
        this.serialPort.removeAllListeners();
        if (this.serialPort.isOpen) {
          this.serialPort.close();
        }
      } catch (error) {
        this.platform.log.error('Error cleaning up serial port:', error);
      }
    }

    try {
      this.serialPort = new SerialPort(
        { path: this.serialPortName, baudRate: 230400 },
        (err) => {
          if (err) {
            this.platform.log.error('Failed to open serial port:', err.message);
            this.scheduleReconnect();
          } else {
            this.platform.log.info('Serial port opened successfully');
            if (this.reconnectInterval) {
              clearInterval(this.reconnectInterval);
              this.reconnectInterval = null;
            }
          }
        },
      );
    } catch (error) {
      this.platform.log.error('Error creating serial port:', error);
      this.scheduleReconnect();
      return;
    }

    this.serialPort.on('error', (err) => {
      this.platform.log.error('Serial port error:', err.message);
      this.scheduleReconnect();
    });

    this.serialPort.on('close', () => {
      this.platform.log.warn('Serial port closed');
      this.scheduleReconnect();
    });

    // Actually, we don't need to read any data
    // However, Flipperzero stop receiving any data if we don't read it after about a 10-15 individual commands
    this.serialPort.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');

      // Process all complete lines
      while (lines.length > 1) {
        const completeLine = lines.shift()!.trim();
        this.platform.log.debug('Received serial response:', completeLine);
      }

      // Keep the last incomplete line in the buffer
      this.buffer = lines[0];
    });
  }

  private scheduleReconnect() {
    if (!this.reconnectInterval) {
      this.reconnectInterval = setInterval(() => {
        this.platform.log.info('Attempting to reconnect to serial port...');
        this.initializeSerialPort();
      }, RECONNECT_INTERVAL);
    }
  }

  // IR signals
  parseIRFile(filePath: string) {
    const content = fs.readFileSync(filePath, 'utf8');
    const signals: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    let currentSignal: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

    content.split('\n').forEach(line => {
      line = line.trim();
      if (line.startsWith('name:')) {
        if (currentSignal) {
          signals[currentSignal.name] = currentSignal;
        }
        currentSignal = { name: line.split(':')[1].trim() };
      } else if (currentSignal) {
        if (line.startsWith('frequency:')) {
          currentSignal.frequency = parseInt(line.split(':')[1]);
        } else if (line.startsWith('duty_cycle:')) {
          currentSignal.dutyCycle = parseFloat(line.split(':')[1]) * 100;
        } else if (line.startsWith('data:')) {
          currentSignal.data = line.split(':')[1].trim().split(' ').map(Number);
        }
      }
    });

    if (currentSignal) {
      signals[currentSignal.name] = currentSignal;
    }
    return signals;
  }

  async sendIRSignal(signal: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.platform.log.info('Will send IR signal:', signal.name);
    if (!this.serialPort || !this.serialPort.isOpen) {
      this.platform.log.warn(`Serial port is not open. Cannot send IR signal. ${signal.name}`);
      return;
    }
    // Docs says Flipper can handle up to 512 samples of IR data,
    // but there's likely an issue with serial port stripping data.
    // Chunking it to a safe value
    //
    // https://docs.flipper.net/development/cli/#FEjwz
    const chunkSize = 512 / 8;
    const totalChunks = Math.ceil(signal.data.length / chunkSize);

    // Sending IR data from Flipper may be not reliable, so we'll try a few times
    // https://t.me/flipperzero/103920/241710
    return this.mutex.runExclusive(async () => {
      for (let _try = 0; _try < IR_SIGNAL_SEND_TRIES; _try++) {
        this.platform.log.debug('Sending IR signal:', signal.name, ` try: (${_try + 1}/${IR_SIGNAL_SEND_TRIES})`);
        for (let i = 0; i < signal.data.length; i += chunkSize) {
          const chunk = signal.data.slice(i, i + chunkSize);
          const command = `ir tx RAW F:${signal.frequency} DC:${signal.dutyCycle} ${chunk.join(' ')}\r\n`;
          try {
            await new Promise<void>((resolve, reject) => {
              const skipDrain = this.serialPort!.write(command, (err) => {
                if (err) {
                  this.platform.log.error('Error writing to serial port:', err.message);
                  reject(err);
                }
              });
              if (!skipDrain) {
                this.platform.log.debug('Draining serial port after:', signal.name, ` try: (${_try + 1}/${IR_SIGNAL_SEND_TRIES})`);
                this.serialPort!.drain(
                  (err) => {
                    if (err) {
                      this.platform.log.error('Error draining serial port:', err.message);
                      reject(err);
                    }
                  },
                );
              }
              resolve();
            });
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error) {
            const chunkNumber = Math.ceil((i + chunkSize) / chunkSize);
            this.platform.log.error(`Failed to send chunk ${chunkNumber}/${totalChunks} of IR signal ${signal.name}:`, error);
            break;
          }
        }
      }
    });
  }

  private updateState(update: AccessoryStateUpdate) {
    Object.keys(update).forEach(key => {
      // @ts-expect-error dicts are hard in TS
      this.accessoryState[key] = update[key];
      if (this.updateDebouncers[key]) {
        clearTimeout(this.updateDebouncers[key]);
      }
      this.updateDebouncers[key] = setTimeout(() => {
        // Update the accessory context
        this.accessory.context.state = this.accessoryState;
        this.platform.api.updatePlatformAccessories([this.accessory]);

        // Send the IR signal
        this.sendUpdatedState();

        // Update the previous state
        this.previousState = { ...this.accessoryState };
      }, DEBOUNCE_TIME); // ms debounce time
    });
  }

  private sendUpdatedState() {
    if (this.accessoryState.On !== this.previousState.On) {
      if (this.accessoryState.On) {
        // Fan was turned on, send the appropriate speed command

        // @ts-expect-error dicts are hard in TS
        this.sendSpeedCommand(this.accessoryState.Speed);
      } else {
        // Fan was turned off
        this.sendIRSignal(this.irSignals['Fan_off']);
      }
    } else if (this.accessoryState.On && this.accessoryState.Speed !== this.previousState.Speed) {
      // Fan is on and speed has changed

      // @ts-expect-error dicts are hard in TS
      this.sendSpeedCommand(this.accessoryState.Speed);
    }
  }

  private sendSpeedCommand(speed: number) {
    if (speed < MEDIUM_THRESHOLD) {
      this.sendIRSignal(this.irSignals['Fan_low']);
    } else if (speed < HIGH_THRESHOLD) {
      this.sendIRSignal(this.irSignals['Fan_med']);
    } else {
      this.sendIRSignal(this.irSignals['Fan_high']);
    }
  }

  async setOn(value: CharacteristicValue) {
    this.platform.log.debug('Set On state ->', value);
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    this.updateState({ On: value as boolean });
  }

  async getOn(): Promise<CharacteristicValue> {
    const isOn = this.accessoryState.On;
    this.platform.log.debug('Get On state ->', isOn);
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return isOn;
  }

  async setSpeed(value: CharacteristicValue) {
    this.platform.log.debug('Set Speed -> ', value);
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    this.updateState({ Speed: value as number });
  }

  async getSpeed(): Promise<CharacteristicValue> {
    const speed = this.accessoryState.Speed;
    this.platform.log.debug('Get Speed -> ', speed);
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return speed;
  }
}