/* Sleep Monitor
change wifi to use
*/

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <SD.h>
#include <time.h>
#include <driver/i2s.h>
#include <math.h>

#include <esp_task_wdt.h>
#include <freertos/semphr.h>
#include <MAX30105.h>

// WIFI CHANGES
static const char* WIFI_SSID = "TrangTu";
static const char* WIFI_PASS = "12021997";

//  WAV (PCM16LE, mono) helpers 
static inline bool wrLE16(File& f, uint16_t v) {
  uint8_t b[2] = { (uint8_t)(v & 0xFF), (uint8_t)((v >> 8) & 0xFF) };
  return f.write(b, 2) == 2;
}
static inline bool wrLE32(File& f, uint32_t v) {
  uint8_t b[4] = {
    (uint8_t)(v & 0xFF),
    (uint8_t)((v >> 8) & 0xFF),
    (uint8_t)((v >> 16) & 0xFF),
    (uint8_t)((v >> 24) & 0xFF)
  };
  return f.write(b, 4) == 4;
}
static inline bool wr4(File& f, const char* s4) {
  return f.write((const uint8_t*)s4, 4) == 4;
}

static bool wavWriteHeaderAt(File& f, uint32_t sampleRate, uint32_t dataBytes) {
  const uint16_t channels = 1;
  const uint16_t bits = 16;
  const uint32_t byteRate = sampleRate * (uint32_t)channels * (uint32_t)bits / 8u;
  const uint16_t blockAlign = (uint16_t)(channels * (bits / 8u));
  const uint32_t riffSize = 36u + dataBytes;

  bool ok = true;
  ok = ok && wr4(f, "RIFF");
  ok = ok && wrLE32(f, riffSize);
  ok = ok && wr4(f, "WAVE");
  ok = ok && wr4(f, "fmt ");
  ok = ok && wrLE32(f, 16u);
  ok = ok && wrLE16(f, 1u); // PCM
  ok = ok && wrLE16(f, channels);
  ok = ok && wrLE32(f, sampleRate);
  ok = ok && wrLE32(f, byteRate);
  ok = ok && wrLE16(f, blockAlign);
  ok = ok && wrLE16(f, bits);
  ok = ok && wr4(f, "data");
  ok = ok && wrLE32(f, dataBytes);
  return ok;
}

static size_t fileWriteAll(File& f, const uint8_t* buf, size_t n) {
  size_t off = 0;
  while (off < n) {
    size_t wn = f.write(buf + off, n - off);
    if (wn == 0) break;
    off += wn;
    if ((off & 0x1FFFu) == 0) delay(1);
  }
  return off;
}

static bool wavOpen(File& f, const char* path, uint32_t sampleRate, uint32_t dataBytes) {
  if (SD.exists(path)) SD.remove(path);
  f = SD.open(path, FILE_WRITE);
  if (!f) return false;
  if (!f.seek(0)) { f.close(); return false; }
  if (!wavWriteHeaderAt(f, sampleRate, dataBytes)) { f.close(); return false; }
  return true;
}

static size_t wavAppendPcm16(File& f, const int16_t* pcm, size_t samples) {
  return fileWriteAll(f, (const uint8_t*)pcm, samples * 2u);
}

static void wavClose(File& f, uint32_t sampleRate, uint32_t dataBytes) {
  (void)sampleRate; (void)dataBytes;
  if (!f) return;
  f.flush();
  f.close();
}

//  WIFI/API 

static const char* API_HOST = "sleepmon-api.sleepmon.workers.dev";
static const uint16_t API_PORT = 443;
static const char* API_TELEM_PATH  = "/telemetry";
static const char* API_ABN_MARK_PATH = "/abnormal/mark";

static const char* AUTH_TOKEN = "khongaibietcaimatkhaulagihetbana";
// TIMEZONE (Hà Nội GMT+7)
static const char* TZ_INFO = "ICT-7";

//  PINS 
static const int PIN_I2C_SDA = 21;
static const int PIN_I2C_SCL = 22;

static const int PIN_I2S_BCLK = 25;
static const int PIN_I2S_WS   = 26;
static const int PIN_I2S_SD   = 33;

static const int PIN_SD_SCK  = 18;
static const int PIN_SD_MISO = 19;
static const int PIN_SD_MOSI = 23;
static const int PIN_SD_CS   = 5;
static const int PIN_BUZZER  = 27;

//  AUDIO 
static const int AUDIO_FS = 16000;
static const int AUDIO_BLOCK_SAMPLES = 512;

static const int AUDIO_I2S_SHIFT = 9;

static const int SEG_SECONDS = 30;
static constexpr uint32_t SEG_SAMPLES_TARGET = (uint32_t)SEG_SECONDS * (uint32_t)AUDIO_FS;

static const int AUDIO_FAST_MS = 100;
static const int AUDIO_FAST_SAMPLES = (AUDIO_FS * AUDIO_FAST_MS) / 1000;

static const float QUIET_RMS = 0.0020f;
static const float   SNORE_RMS_MIN   = 0.0080f;
static const int32_t SNORE_P2P_MIN   = 1800;

//  PPG (SpO2 only) 
static const float MIN_VALID_SPO2 = 70.0f;
static const uint32_t PPG_WARMUP_MS = 3000;
static const float PI_OK_MIN = 0.25f;

// IR weak fix (threshold + auto gain)
static volatile uint8_t gIrLed = 0x50;
static const uint32_t MAX3010X_SAT_COUNTS  = 250000;
static const uint32_t MAX3010X_TARGET_MIN  = 30000;
static const uint32_t MAX3010X_TARGET_MAX  = 160000;

//  OSA FSM THRESHOLDS 
static const uint32_t TIME_APNEA_LIMIT_MS = 10000;
static const float    SPO2_DROP_PERCENT   = 3.0f;

static const float AUDIO_THRESHOLD_MIN = 0.0035f;
static const float AUDIO_K_THR         = 1.35f;
static const float AUDIO_HYS_DOWN      = 0.90f;
static const float AUDIO_HYS_UP        = 1.10f;

//  ENV NOISE (fan/AC/robot) 
static const float    ENV_RMS_MIN        = 0.0025f;
static const float    ENV_CV8_HUM_ON     = 0.030f;
static const float    ENV_CV8_HUM_OFF    = 0.060f;
static const float    ENV_HFR_HUM_MAX    = 0.16f;
static const float    ENV_CV8_MECH_ON    = 0.090f;
static const float    ENV_CV8_MECH_OFF   = 0.140f;
static const float    ENV_HFR_MECH_MIN   = 0.14f;
static const uint8_t  ENV_ON_SEC         = 8;
static const uint8_t  ENV_OFF_SEC        = 3;

//  DEBUG PRINT 
static const bool DBG_AUDIO = true;
static const bool DBG_PPG   = true;
static const bool DBG_FSM   = true;
static const bool DBG_PPG_RAW = true;

//  SD PATHS 
static const char* ROOT_DIR   = "/SleepMon";
static const char* SUB_SOUND  = "Sound";
static const char* SUB_SPO2   = "SpO2";

// Check if SD storage usage is above 90%
bool checkSDStorage() {
  uint64_t totalBytes = SD.totalBytes();
  uint64_t usedBytes = SD.usedBytes();
  float usage = (float)usedBytes / (float)totalBytes * 100;

  Serial.printf("[SD] Total: %llu MB, Used: %llu MB, Usage: %.2f%%\n", 
                totalBytes / (1024 * 1024), 
                usedBytes / (1024 * 1024),
                usage);

  return (usage >= 90.0);
}

// Delete old files (older than 3 days)
void deleteOldFiles() {
  time_t now = time(nullptr);
  struct tm tmv;
  localtime_r(&now, &tmv);

  File dir = SD.open(ROOT_DIR);
  if (dir && dir.isDirectory()) {
    dir.rewindDirectory();
    while (true) {
      File entry = dir.openNextFile();
      if (!entry) break;

      String filename = entry.name();
      if (filename.endsWith(".csv") || filename.endsWith(".wav")) {
        int year, month, day;
        sscanf(filename.c_str(), "%d-%d-%d", &day, &month, &year);

        struct tm fileDate = {0};
        fileDate.tm_year = year - 1900;
        fileDate.tm_mon = month - 1;
        fileDate.tm_mday = day;

        time_t fileTime = mktime(&fileDate);
        if (difftime(now, fileTime) > 3 * 24 * 60 * 60) {
          Serial.printf("[SD] Deleting old file: %s\n", filename.c_str());
          SD.remove(entry.name());
        }
      }
      entry.close();
    }
  }
  dir.close();
}

//  GLOBAL STATE 
static volatile bool   gSdOk = false;

static SemaphoreHandle_t gSdMutex = nullptr;
static inline bool sdLock(uint32_t timeoutMs = 25) {
  if (!gSdMutex) return true;
  return (xSemaphoreTake(gSdMutex, pdMS_TO_TICKS(timeoutMs)) == pdTRUE);
}
static inline void sdUnlock() {
  if (gSdMutex) xSemaphoreGive(gSdMutex);
}

static volatile int    gFinger = 0;
static volatile float  gSpO2   = -1.0f;
static volatile float  gPI     = 0.0f;
static volatile int    gPPG_OK = 0;
static volatile uint32_t gFingerStableSinceMs = 0;
static volatile uint32_t gPpgOkSinceMs = 0;

static volatile float  gSpO2Base = -1.0f;

static volatile float  gAudioRmsFast = 0.0f;
static volatile int32_t gAudioP2PFast = 0;

static volatile float  gAudioRms1s = 0.0f;
static volatile float  gAudioZ   = 0.0f;
static volatile float  gAudioHfr = 0.0f;
static volatile int32_t gAudioP2P = 0;
static volatile float  gCv8 = 0.0f;
static volatile float  gNoiseFloorRms  = QUIET_RMS;
static volatile uint8_t gEnvNoise      = 0;
static volatile uint8_t gEnvMode       = 0;

static volatile uint8_t gSnore = 0;
static volatile uint8_t gSnoreAbn = 0;
static volatile uint8_t gSnoreWin10 = 0;

static volatile int gAlarmA = 0;
static volatile int gMarkSegAbnReq = 0;

//  SPO2 DAILY LOG (one file per day) 
static char     gSpo2DayStr[16] = {0};
static uint32_t gSpo2RowIdx     = 0;

// MAX30102
static MAX30105 maxSensor;

//  TIME
static uint32_t nowEpoch() {
  time_t tnow = time(nullptr);
  if (tnow < 1700000000) return 0;
  return (uint32_t)tnow;
}

static void fmtDate(uint32_t ts, char out[16]) {
  time_t tt = (time_t)ts;
  struct tm tmv;
  localtime_r(&tt, &tmv);
  snprintf(out, 16, "%02d-%02d-%04d", tmv.tm_mday, tmv.tm_mon + 1, tmv.tm_year + 1900);
}
static void fmtTime(uint32_t ts, char out[16]) {
  time_t tt = (time_t)ts;
  struct tm tmv;
  localtime_r(&tt, &tmv);
  snprintf(out, 16, "%02d-%02d-%02d", tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
}
static void fmtTimeColon(uint32_t ts, char out[16]) {
  time_t tt = (time_t)ts;
  struct tm tmv;
  localtime_r(&tt, &tmv);
  snprintf(out, 16, "%02d:%02d:%02d", tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
}

static void ensureDirsForDate(const char* dateStr) {
  SD.mkdir(ROOT_DIR);

  String dayDir = String(ROOT_DIR) + "/" + dateStr;
  SD.mkdir(dayDir.c_str());

  String s = dayDir + "/" + SUB_SOUND;
  String p = dayDir + "/" + SUB_SPO2;
  SD.mkdir(s.c_str());
  SD.mkdir(p.c_str());
}

// /SleepMon/<date>/Sound/HH-MM-SS_DD-MM-YYYY.wav
static String makeSoundPath(uint32_t startTs) {
  char dateStr[16], timeStr[16];
  fmtDate(startTs, dateStr);
  fmtTime(startTs, timeStr);
  ensureDirsForDate(dateStr);

  String base = String(ROOT_DIR) + "/" + dateStr + "/" + SUB_SOUND + "/";
  base += String(timeStr) + "_" + String(dateStr) + ".wav";
  return base;
}

// If abnormal: insert "_ABNORMAL" before ".wav"
static String makeAbnormalRenamedPath(const char* currentPath) {
  String p = String(currentPath);

  // must end with .wav (case-sensitive like your naming)
  if (!p.endsWith(".wav")) return "";

  // avoid double-tagging
  if (p.indexOf("_ABNORMAL.wav") >= 0) return p;

  int dot = p.lastIndexOf(".wav");
  if (dot < 0) return "";

  String out = p.substring(0, dot);
  out += "_ABNORMAL.wav";
  return out;
}

// /SleepMon/<date>/SpO2/<date>.csv
static String makeSpo2DailyPath(uint32_t ts) {
  char dateStr[16];
  fmtDate(ts, dateStr);
  ensureDirsForDate(dateStr);
  String p = String(ROOT_DIR) + "/" + dateStr + "/" + SUB_SPO2 + "/";
  p += String(dateStr) + ".csv";
  return p;
}

//  WIFI/NTP 
static void wifiConnect() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("WiFi connected.");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

static bool timeSync() {
  configTzTime(TZ_INFO, "pool.ntp.org", "time.nist.gov", "time.google.com");
  uint32_t t0 = millis();
  while (millis() - t0 < 15000) {
    if (nowEpoch() != 0) return true;
    delay(250);
    Serial.print(".");
  }
  return false;
}

// SD INIT
static bool sdInit() {
  SPI.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, PIN_SD_CS);
  const uint32_t hzTry[] = { 1000000, 4000000, 400000 };
  for (uint32_t hz : hzTry) {
    Serial.printf("[SD] trying init @ %u Hz...\n", (unsigned)hz);
    if (SD.begin(PIN_SD_CS, SPI, hz)) {
      uint64_t total = SD.totalBytes();
      uint64_t used  = SD.usedBytes();
      Serial.printf("[SD] OK total=%llu MB used=%llu MB\n",
                    (unsigned long long)(total / (1024ULL*1024ULL)),
                    (unsigned long long)(used  / (1024ULL*1024ULL)));
      SD.mkdir(ROOT_DIR);

      if (checkSDStorage()) {
        deleteOldFiles();
      }

      return true;
    }
  }
  Serial.println("[SD] SD.begin failed!");
  return false;
}

//  HTTPS 
static int parseHttpCode(const String& statusLine) {
  int code = 0;
  int sp1 = statusLine.indexOf(' ');
  if (sp1 > 0) {
    int sp2 = statusLine.indexOf(' ', sp1 + 1);
    if (sp2 > sp1) code = statusLine.substring(sp1 + 1, sp2).toInt();
  }
  return code;
}

static int readHttpStatusCodeNonBlocking(WiFiClientSecure& client, uint32_t timeoutMs) {
  String line;
  line.reserve(64);
  const uint32_t t0 = millis();
  while (client.connected() && !client.available()) {
    if ((millis() - t0) >= timeoutMs) return 0;
    delay(1);
  }

  while (client.connected()) {
    while (client.available()) {
      char c = (char)client.read();
      if (c == '\r') continue;
      if (c == '\n') {
        line.trim();
        return parseHttpCode(line);
      }
      if (line.length() < 80) line += c;
    }
    if ((millis() - t0) >= timeoutMs) break;
    delay(1);
  }

  line.trim();
  return parseHttpCode(line);
}

static bool httpsPostJson(const char* path, const String& body, int* outCode = nullptr) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(12000);
  if (!client.connect(API_HOST, API_PORT)) return false;

  String req;
  req.reserve(320 + body.length());
  req += "POST ";
  req += path;
  req += " HTTP/1.1\r\n";
  req += "Host: ";
  req += API_HOST;
  req += "\r\n";
  req += "Connection: close\r\n";
  req += "Content-Type: application/json\r\n";
  req += "Authorization: Bearer ";
  req += AUTH_TOKEN;
  req += "\r\n";
  req += "Content-Length: ";
  req += String(body.length());
  req += "\r\n\r\n";
  req += body;

  client.print(req);

  int code = readHttpStatusCodeNonBlocking(client, 6000);
  if (outCode) *outCode = code;

  uint32_t td = millis();
  while (client.connected() && (millis() - td) < 1500) {
    while (client.available()) client.read();
    delay(1);
  }
  client.stop();

  return (code >= 200 && code < 300);
}

//  BUZZER 
static void buzzerOn()  { tone(PIN_BUZZER, 2500); }
static void buzzerOff() { noTone(PIN_BUZZER); }

//  I2C RECOVERY (stuck bus) 
static bool initMAX30102();

static bool i2cBusRecover(int sclPin, int sdaPin) {
  pinMode(sclPin, INPUT_PULLUP);
  pinMode(sdaPin, INPUT_PULLUP);
  delay(2);
  int sda = digitalRead(sdaPin);
  int scl = digitalRead(sclPin);
  if (sda == HIGH && scl == HIGH) return true;

  pinMode(sclPin, OUTPUT_OPEN_DRAIN);
  digitalWrite(sclPin, HIGH);
  pinMode(sdaPin, INPUT_PULLUP);

  for (int i = 0; i < 18 && digitalRead(sdaPin) == LOW; i++) {
    digitalWrite(sclPin, LOW);
    delayMicroseconds(5);
    digitalWrite(sclPin, HIGH);
    delayMicroseconds(5);
  }

  pinMode(sdaPin, OUTPUT_OPEN_DRAIN);
  digitalWrite(sdaPin, LOW);
  delayMicroseconds(5);
  digitalWrite(sclPin, HIGH);
  delayMicroseconds(5);
  digitalWrite(sdaPin, HIGH);
  delayMicroseconds(5);

  pinMode(sclPin, INPUT_PULLUP);
  pinMode(sdaPin, INPUT_PULLUP);
  delay(2);

  return (digitalRead(sdaPin) == HIGH);
}

static bool max30102Reinit() {
  Wire.end();
  delay(5);
  i2cBusRecover(PIN_I2C_SCL, PIN_I2C_SDA);
  delay(5);
  return initMAX30102();
}

//  MAX30102 
static bool initMAX30102() {
  i2cBusRecover(PIN_I2C_SCL, PIN_I2C_SDA);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(400000);
  for (int attempt = 1; attempt <= 3; attempt++) {
    if (maxSensor.begin(Wire, I2C_SPEED_FAST)) {
      byte ledBrightness = (byte)gIrLed;
      byte sampleAverage = 8;
      byte ledMode = 2;
      int  sampleRate = 100;
      int  pulseWidth = 411;
      int  adcRange   = 4096;

      maxSensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);

      maxSensor.setPulseAmplitudeIR(gIrLed);
      maxSensor.setPulseAmplitudeRed(0x30);
      maxSensor.setPulseAmplitudeGreen(0);

      maxSensor.clearFIFO();
      Serial.printf("MAX30102 init OK. ledIR=0x%02X adcRange=%d pw=%d sr=%d avg=%d\n",
                    (unsigned)gIrLed, adcRange, pulseWidth, sampleRate, sampleAverage);
      return true;
    }

    Serial.printf("MAX30102 init FAIL (attempt %d). Recovering I2C...\n", attempt);
    Wire.end();
    delay(10);
    i2cBusRecover(PIN_I2C_SCL, PIN_I2C_SDA);
    delay(10);
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    Wire.setClock(400000);
  }

  Serial.println("MAX30102 init FAIL (all attempts).");
  return false;
}

//  I2S 
static bool initI2S() {
  i2s_config_t cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
  cfg.sample_rate = AUDIO_FS;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_I2S;
  cfg.intr_alloc_flags = 0;
  cfg.dma_buf_count = 8;
  cfg.dma_buf_len   = AUDIO_BLOCK_SAMPLES;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = false;
  cfg.fixed_mclk = 0;

  i2s_pin_config_t pin;
  memset(&pin, 0, sizeof(pin));
  pin.bck_io_num = PIN_I2S_BCLK;
  pin.ws_io_num  = PIN_I2S_WS;
  pin.data_out_num = I2S_PIN_NO_CHANGE;
  pin.data_in_num  = PIN_I2S_SD;
  pin.mck_io_num    = I2S_PIN_NO_CHANGE;

  esp_err_t err = i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  if (err != ESP_OK) return false;
  err = i2s_set_pin(I2S_NUM_0, &pin);
  if (err != ESP_OK) {
    i2s_driver_uninstall(I2S_NUM_0);
    return false;
  }

  i2s_zero_dma_buffer(I2S_NUM_0);
  Serial.println("I2S init OK.");
  return true;
}

//  QUEUES 
struct MarkJob { uint32_t ts; char filename[64]; };
static QueueHandle_t gMarkQ = nullptr;

// Spo2 append job (SD worker)
struct Spo2Job {
  uint32_t segStartTs;
  char segName[64];            // final filename 
  int16_t spo2[SEG_SECONDS];   // -1 invalid
  uint8_t abn[SEG_SECONDS];    // 1 abnormal
};
static QueueHandle_t gSpo2Q = nullptr;

//  SD WORKER TASK (append spo2 only) 
static void taskSDWorker(void* pv) {
  Serial.printf("[Core%d] taskSDWorker start\n", xPortGetCoreID());

  for (;;) {
    Spo2Job sj{};
    if (gSpo2Q && xQueueReceive(gSpo2Q, &sj, pdMS_TO_TICKS(50)) == pdTRUE) {
      char dayStr[16];
      fmtDate(sj.segStartTs, dayStr);

      if (strcmp(gSpo2DayStr, dayStr) != 0) {
        strncpy(gSpo2DayStr, dayStr, sizeof(gSpo2DayStr) - 1);
        gSpo2DayStr[sizeof(gSpo2DayStr) - 1] = 0;
        gSpo2RowIdx = 0;
      }

      String sp;
      if (sdLock(300)) {
        sp = makeSpo2DailyPath(sj.segStartTs);
        sdUnlock();
      }
      if (sp.length() == 0) {
        vTaskDelay(pdMS_TO_TICKS(1));
        continue;
      }

      bool needHeader = false;
      if (sdLock(200)) {
        needHeader = !SD.exists(sp.c_str());
        sdUnlock();
      }

      File sf;
      if (sdLock(200)) {
        sf = SD.open(sp.c_str(), FILE_APPEND);
        sdUnlock();
      }

      if (sf) {
        if (needHeader) {
          if (sdLock(200)) {
            sf.print("idx,time,spo2,abnormal\n");
            sdUnlock();
          }
        }

        for (int i = 0; i < SEG_SECONDS; i++) {
          gSpo2RowIdx++;

          char hhmmss[16];
          fmtTimeColon(sj.segStartTs + (uint32_t)i, hhmmss);

          if (!sdLock(200)) { vTaskDelay(pdMS_TO_TICKS(1)); i--; continue; }

          sf.print(gSpo2RowIdx);
          sf.print(',');
          sf.print(hhmmss);
          sf.print(',');
          if (sj.spo2[i] >= 0) sf.print(sj.spo2[i]);
          sf.print(',');
          if (sj.abn[i]) sf.print('*');
          sf.print('\n');

          sdUnlock();

          if ((i % 5) == 4) vTaskDelay(pdMS_TO_TICKS(1));
        }

        if (sdLock(200)) { 
          sf.flush();
          sdUnlock();
        }
        sf.close(); 
        Serial.printf("[SDW] Spo2 appended: %s\n", sp.c_str());
      }
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

//  PPG TASK (SpO2 only) 
static void taskPPG(void* pv) {
  Serial.printf("[Core%d] taskPPG start\n", xPortGetCoreID());
  float irBase = 0.0f, redBase = 0.0f;
  float irAc = 0.0f, redAc = 0.0f;

  const float baseAlpha = 0.01f;
  const float acAlpha   = 0.05f;

  const float IR_FINGER_MIN = 7000.0f;
  const float IR_FINGER_MAX = 220000.0f;
  const float IR_MARGIN     = 2500.0f;

  const float IR_DC_MIN     = 1.0f;
  const float PI_FINGER_MIN = 0.0010f;

  float irFingerTh = 12000.0f;
  uint8_t onCnt = 0, offCnt = 0;

  float spo2Est = -1.0f;
  float spo2Ring[5] = {0};
  uint8_t spo2Idx = 0;
  uint8_t spo2Cnt = 0;

  auto pushSpo2 = [&](float s) -> float {
    spo2Ring[spo2Idx] = s;
    spo2Idx = (uint8_t)((spo2Idx + 1) % 5);
    if (spo2Cnt < 5) spo2Cnt++;
    float sum = 0.0f;
    for (uint8_t i = 0; i < spo2Cnt; i++) sum += spo2Ring[i];
    return sum / (float)spo2Cnt;
  };

  uint32_t lastLedTune = 0;
  uint32_t lastRawDbg  = 0;
  uint32_t lastSampleMs = millis();
  uint32_t stallCheckMs = millis();
  uint16_t yieldCtr = 0;

  for (;;) {
    maxSensor.check();
    while (maxSensor.available()) {
      uint32_t ir  = maxSensor.getIR();
      uint32_t red = maxSensor.getRed();
      maxSensor.nextSample();
      lastSampleMs = millis();
      if ((++yieldCtr & 0x1F) == 0) vTaskDelay(pdMS_TO_TICKS(1));

      if (irBase <= 1.0f) irBase = (float)ir;
      if (redBase <= 1.0f) redBase = (float)red;

      irBase  = (1.0f - baseAlpha) * irBase  + baseAlpha * (float)ir;
      redBase = (1.0f - baseAlpha) * redBase + baseAlpha * (float)red;
      irAc  = (1.0f - acAlpha) * irAc  + acAlpha * fabsf((float)ir  - irBase);
      redAc = (1.0f - acAlpha) * redAc + acAlpha * fabsf((float)red - redBase);

      float irDc = fmaxf(irBase, IR_DC_MIN);
      float pi = 100.0f * (irAc / irDc);
      gPI = pi;

      float thr = irBase + IR_MARGIN;
      if (thr < IR_FINGER_MIN) thr = IR_FINGER_MIN;
      if (thr > IR_FINGER_MAX) thr = IR_FINGER_MAX;
      irFingerTh = 0.995f * irFingerTh + 0.005f * thr;

      bool fingerRaw = ((float)ir > irFingerTh) && ((irAc / irDc) > PI_FINGER_MIN);
      if (fingerRaw) { onCnt++; offCnt = 0; }
      else { offCnt++; onCnt = 0; }

      if (gFinger == 0 && onCnt >= 8) {
        gFinger = 1;
        gFingerStableSinceMs = millis();
        gPpgOkSinceMs = 0;
        spo2Est = -1.0f;
        spo2Cnt = 0;
      }
      if (gFinger == 1 && offCnt >= 25) {
        gFinger = 0;
        gFingerStableSinceMs = 0;
        gPpgOkSinceMs = 0;
        gSpO2 = -1.0f; gPPG_OK = 0;
        gSpO2Base = -1.0f;
        spo2Est = -1.0f;
        spo2Cnt = 0;
        continue;
      }

      uint32_t nowMs = millis();
      if (nowMs - lastLedTune >= 500) {
        lastLedTune = nowMs;
        if (ir > MAX3010X_SAT_COUNTS || red > MAX3010X_SAT_COUNTS) {
          if (gIrLed > 0x10) gIrLed = (uint8_t)max(0x10, (int)gIrLed - 0x10);
          maxSensor.setPulseAmplitudeIR(gIrLed);
        } else {
          if (ir < MAX3010X_TARGET_MIN && gIrLed < 0xFF) {
            gIrLed = (uint8_t)min(255, (int)gIrLed + 0x04);
            maxSensor.setPulseAmplitudeIR(gIrLed);
          } else if (ir > MAX3010X_TARGET_MAX && gIrLed > 0x20) {
            gIrLed = (uint8_t)max(0x20, (int)gIrLed - 0x04);
            maxSensor.setPulseAmplitudeIR(gIrLed);
          }
        }
      }

      if (gFinger == 1) {
        float redDc = fmaxf(redBase, 1.0f);
        float ratio = (redAc / redDc) / fmaxf((irAc / irDc), 1e-6f);

        float s = 110.0f - 25.0f * ratio;
        if (s > 100.0f) s = 100.0f;
        if (s < 70.0f)  s = 70.0f;

        if (spo2Est < 0) spo2Est = s;
        else spo2Est = 0.90f * spo2Est + 0.10f * s;

        float spo2Smooth = pushSpo2(spo2Est);
        gSpO2 = spo2Smooth;

        uint32_t dtStable = (gFingerStableSinceMs ? (millis() - gFingerStableSinceMs) : 0);
        if (dtStable >= PPG_WARMUP_MS && gPI >= PI_OK_MIN && gSpO2 > 0) {
          gPPG_OK = 1;
          if (gPpgOkSinceMs == 0) gPpgOkSinceMs = millis();
        } else {
          gPPG_OK = 0;
          gPpgOkSinceMs = 0;
        }
      }

      if (DBG_PPG_RAW) {
        uint32_t now = millis();
        if (now - lastRawDbg >= 1000) {
          lastRawDbg = now;
          Serial.printf("[RAW] IR=%lu RED=%lu irBase=%.0f irAc=%.0f PI=%.3f irTh=%.0f ledIR=0x%02X finger=%d spo2=%.1f ok=%d\n",
            (unsigned long)ir, (unsigned long)red,
            (double)irBase, (double)irAc, (double)gPI, (double)irFingerTh,
            (unsigned)gIrLed, gFinger, (double)gSpO2, gPPG_OK
          );
        }
      }
    }

    uint32_t msNow = millis();
    if ((msNow - stallCheckMs) >= 1000) {
      stallCheckMs = msNow;
      if ((msNow - lastSampleMs) > 2000) {
        Serial.println("[PPG] No samples >2s -> reinit MAX30102");
        max30102Reinit();
        lastSampleMs = msNow;
      }
    }

    if (DBG_PPG) {
      static uint32_t lastPrint = 0;
      uint32_t now = millis();
      if (now - lastPrint >= 1000) {
        lastPrint = now;
        Serial.printf("[PPG] finger=%d PI=%.3f SpO2=%.1f PPG_OK=%d base=%.1f ledIR=0x%02X\n",
                      gFinger, (double)gPI, (double)gSpO2, gPPG_OK, (double)gSpO2Base, (unsigned)gIrLed);
      }
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

//  AUDIO TASK 
static void taskAudio(void* pv) {
  Serial.printf("[Core%d] taskAudio start\n", xPortGetCoreID());

  File segFile;
  bool segOpened = false;

  uint32_t segStartTs = 0;
  uint32_t segStartMs = 0;
  uint32_t segSamplesWritten = 0;
  uint32_t segDataBytes = 0;
  char segPath[128] = {0};

  bool segMarkedAbn = false;
  uint32_t segFirstAbnTs = 0;

  // Per-second SpO2 table for this segment
  int16_t segSpo2Log[SEG_SECONDS];        // -1 = invalid
  uint8_t segSpo2AbnLog[SEG_SECONDS];     // 1 = abnormal during that second
  uint32_t segLastLoggedSec = 0xFFFFFFFFu;

  // Segment integrity stats
  uint32_t segMaxAbs = 0;
  uint32_t segClipCount = 0;
  uint32_t segMaxI2sReadUs = 0;
  uint32_t segMaxSdWriteUs = 0;

  auto openNewSeg = [&]() -> bool {
    if (!gSdOk) return false;

    segStartTs = nowEpoch();

    String path;
    if (!sdLock(300)) {
      Serial.println("[SD] lock timeout (openNewSeg)");
      return false;
    }
    path = makeSoundPath(segStartTs);
    sdUnlock();

    strncpy(segPath, path.c_str(), sizeof(segPath) - 1);
    segPath[sizeof(segPath) - 1] = 0;

    segMarkedAbn = false;
    segFirstAbnTs = 0;
    segLastLoggedSec = 0xFFFFFFFFu;
    for (int i = 0; i < SEG_SECONDS; i++) { segSpo2Log[i] = -1; segSpo2AbnLog[i] = 0; }

    segDataBytes = 0;
    segSamplesWritten = 0;
    segStartMs = millis();
    segMaxAbs = 0;
    segClipCount = 0;
    segMaxI2sReadUs = 0;
    segMaxSdWriteUs = 0;
    segOpened = false;

    const uint32_t expectedDataBytes = (uint32_t)SEG_SAMPLES_TARGET * 2u;

    if (!sdLock(300)) {
      Serial.println("[SD] lock timeout (wavOpen)");
      return false;
    }
    bool ok = wavOpen(segFile, segPath, (uint32_t)AUDIO_FS, expectedDataBytes);
    sdUnlock();

    if (!ok) {
      Serial.printf("[SD] SEG open FAIL %s\n", segPath);
      return false;
    }

    segOpened = true;
    Serial.printf("[SD] SEG open %s\n", segPath);
    return true;
  };

  auto closeSeg = [&]() {
    if (!segOpened) return;

    const uint32_t expectedSamples = (uint32_t)SEG_SAMPLES_TARGET;

    // pad zeros to exact size (short lock)
    while (segSamplesWritten < expectedSamples) {
      static int16_t zpcm[256];
      memset(zpcm, 0, sizeof(zpcm));
      uint32_t left = expectedSamples - segSamplesWritten;
      uint32_t chunk = (left > 256u) ? 256u : left;

      if (!sdLock(50)) { vTaskDelay(pdMS_TO_TICKS(1)); continue; }
      size_t wb = wavAppendPcm16(segFile, zpcm, chunk);
      sdUnlock();

      uint32_t ws = (uint32_t)(wb / 2u);
      if (ws == 0) { vTaskDelay(pdMS_TO_TICKS(1)); continue; }
      segSamplesWritten += ws;
    }
    segDataBytes = segSamplesWritten * 2u;

    // close file 
    if (sdLock(200)) {
      wavClose(segFile, (uint32_t)AUDIO_FS, segDataBytes);
      sdUnlock();
    } else {
      wavClose(segFile, (uint32_t)AUDIO_FS, segDataBytes);
    }

    // If abnormal: rename filename to include _ABNORMAL
    if (segMarkedAbn && gSdOk) {
      String newPath;
      if (sdLock(300)) {
        newPath = makeAbnormalRenamedPath(segPath);
        if (newPath.length() > 0) {
          if (SD.exists(newPath.c_str())) SD.remove(newPath.c_str());
          bool ok = SD.rename(segPath, newPath.c_str());
          if (ok) {
            strncpy(segPath, newPath.c_str(), sizeof(segPath) - 1);
            segPath[sizeof(segPath) - 1] = 0;
            Serial.printf("[SD] RENAMED -> %s\n", segPath);
          } else {
            Serial.printf("[SD] RENAME FAIL (%s)\n", segPath);
          }
        }
        sdUnlock();
      }
    }

    const uint32_t wallMs = (segStartMs > 0) ? (millis() - segStartMs) : 0;
    Serial.printf("[SD] SEG close wrote=%lu samples=%lu wallMs=%lu maxAbs=%lu clip=%lu maxI2S=%luus maxSD=%luus\n",
                  (unsigned long)segDataBytes,
                  (unsigned long)segSamplesWritten,
                  (unsigned long)wallMs,
                  (unsigned long)segMaxAbs,
                  (unsigned long)segClipCount,
                  (unsigned long)segMaxI2sReadUs,
                  (unsigned long)segMaxSdWriteUs);

    segOpened = false;

    //  enqueue SPO2 job 
    if (gSpo2Q) {
      Spo2Job sj{};
      sj.segStartTs = segStartTs;

      const char* segName = strrchr(segPath, '/');
      segName = segName ? (segName + 1) : segPath;
      strncpy(sj.segName, segName, sizeof(sj.segName) - 1);

      memcpy(sj.spo2, segSpo2Log, sizeof(segSpo2Log));
      memcpy(sj.abn,  segSpo2AbnLog, sizeof(segSpo2AbnLog));

      (void)xQueueSend(gSpo2Q, &sj, 0);
    }

    //  upload abnormal filename only
    if (segMarkedAbn && gMarkQ) {
      MarkJob mj{};
      mj.ts = (segFirstAbnTs != 0) ? segFirstAbnTs : segStartTs;

      const char* fn = strrchr(segPath, '/');
      fn = fn ? (fn + 1) : segPath;
      strncpy(mj.filename, fn, sizeof(mj.filename) - 1);

      (void)xQueueSend(gMarkQ, &mj, 0);
    }
  };

  if (gSdOk) openNewSeg();

  float meanR = 0.0f;
  float varR  = 1e-6f;
  float noiseFloor = QUIET_RMS;
  float rmsRing[8] = {0};
  uint8_t rmsIdx8 = 0, rmsCnt8 = 0;

  uint8_t envActive = 0, envMode = 0;
  uint8_t envOnStreak = 0, envOffStreak = 0;

  uint8_t snoreStreak = 0;
  uint8_t snoreRing[10] = {0};
  uint8_t snoreIdx = 0;
  uint8_t snoreCnt = 0;

  uint8_t snAbnStreak = 0;
  bool abnActive = false;

  auto calcCv8 = [&](float& outMean, float& outStd, float& outCv) {
    if (rmsCnt8 == 0) { outMean = 0; outStd = 0; outCv = 0; return; }
    float s = 0.0f;
    for (uint8_t i = 0; i < rmsCnt8; i++) s += rmsRing[i];
    float m = s / (float)rmsCnt8;
    float v = 0.0f;
    for (uint8_t i = 0; i < rmsCnt8; i++) {
      float d = rmsRing[i] - m;
      v += d * d;
    }
    v = v / fmaxf((float)rmsCnt8, 1.0f);
    float sd = sqrtf(fmaxf(v, 1e-12f));
    float cv = sd / fmaxf(m, 1e-6f);
    outMean = m; outStd = sd; outCv = cv;
  };

  // fast window
  uint32_t nF = 0;
  double sumSqF = 0.0;
  int16_t minF = 32767, maxF = -32768;

  // 1s window
  uint32_t nS = 0;
  double sumSqS = 0.0;
  double diffSqS = 0.0;
  uint32_t zcS = 0;
  int16_t minS = 32767, maxS = -32768;
  int16_t prevS = 0;
  bool havePrevS = false;

  int32_t i2sBuf[AUDIO_BLOCK_SAMPLES];
  int16_t pcmBuf[AUDIO_BLOCK_SAMPLES];

  for (;;) {
    size_t bytesRead = 0;
    uint32_t tRead0 = micros();
    esp_err_t err = i2s_read(I2S_NUM_0, (void*)i2sBuf, sizeof(i2sBuf), &bytesRead, portMAX_DELAY);
    uint32_t readUs = (uint32_t)(micros() - tRead0);
    if (readUs > segMaxI2sReadUs) segMaxI2sReadUs = readUs;
    if (err != ESP_OK || bytesRead == 0) continue;

    int n32 = (int)(bytesRead / sizeof(int32_t));
    if (n32 <= 0) continue;

    for (int i = 0; i < n32; i++) {
      int32_t v = i2sBuf[i] >> AUDIO_I2S_SHIFT;
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      pcmBuf[i] = (int16_t)v;
      uint32_t av = (uint32_t)((v >= 0) ? v : -v);
      if (av > segMaxAbs) segMaxAbs = av;
      if (v == 32767 || v == -32768) segClipCount++;
    }

    //  write WAV segment (short lock) 
    if (gSdOk) {
      if (!segOpened) openNewSeg();

      int idx = 0;
      while (idx < n32) {
        if (!segOpened) break;

        uint32_t left = (segSamplesWritten < SEG_SAMPLES_TARGET) ? (SEG_SAMPLES_TARGET - segSamplesWritten) : 0;
        if (segSamplesWritten >= SEG_SAMPLES_TARGET || left == 0) {
          closeSeg();
          openNewSeg();
          if (!segOpened) break;
          left = SEG_SAMPLES_TARGET;
        }

        uint32_t toWrite = (uint32_t)(n32 - idx);
        if (toWrite > left) toWrite = left;

        if (!sdLock(50)) { vTaskDelay(pdMS_TO_TICKS(1)); continue; }
        uint32_t tW0 = micros();
        size_t wb = wavAppendPcm16(segFile, &pcmBuf[idx], toWrite);
        uint32_t wUs = (uint32_t)(micros() - tW0);
        sdUnlock();

        if (wUs > segMaxSdWriteUs) segMaxSdWriteUs = wUs;

        uint32_t wroteSamples = (uint32_t)(wb / 2u);
        if (wroteSamples == 0) {
          vTaskDelay(pdMS_TO_TICKS(1));
          continue;
        }

        segSamplesWritten += wroteSamples;
        segDataBytes = segSamplesWritten * 2u;
        idx += (int)wroteSamples;

        if (segSamplesWritten >= SEG_SAMPLES_TARGET) {
          closeSeg();
          openNewSeg();
        }
      }
    }

    //  features 
    for (int i = 0; i < n32; i++) {
      int16_t s = pcmBuf[i];
      float x = (float)s / 32768.0f;

      sumSqF += (double)x * (double)x;
      nF++;
      if (s < minF) minF = s;
      if (s > maxF) maxF = s;

      sumSqS += (double)x * (double)x;
      nS++;
      if (havePrevS) {
        int16_t a = prevS, b = s;
        if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) zcS++;
        float d = (float)(b - a) / 32768.0f;
        diffSqS += (double)d * (double)d;
      }
      prevS = s;
      havePrevS = true;
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
    }

    if (nF >= (uint32_t)AUDIO_FAST_SAMPLES) {
      float rmsFast = sqrtf((float)(sumSqF / (double)nF));
      int32_t p2pFast = (int32_t)maxF - (int32_t)minF;
      gAudioRmsFast = rmsFast;
      gAudioP2PFast = p2pFast;

      nF = 0;
      sumSqF = 0.0;
      minF = 32767;
      maxF = -32768;
    }

    if (nS >= (uint32_t)AUDIO_FS) {
      float rms1s = sqrtf((float)(sumSqS / (double)nS));
      int32_t p2p = (int32_t)maxS - (int32_t)minS;
      float hfr = (float)(diffSqS / (sumSqS + 1e-12));

      float alpha = 0.02f;
      float diff = rms1s - meanR;
      meanR = meanR + alpha * diff;
      varR  = (1.0f - alpha) * varR + alpha * diff * diff;
      float stdR = sqrtf(fmaxf(varR, 1e-7f));
      float z = (rms1s - meanR) / fmaxf(stdR, 1e-4f);

      gAudioRms1s = rms1s;
      gAudioP2P   = p2p;
      gAudioHfr   = hfr;
      gAudioZ     = z;

      rmsRing[rmsIdx8] = rms1s;
      rmsIdx8 = (uint8_t)((rmsIdx8 + 1) % 8);
      if (rmsCnt8 < 8) rmsCnt8++;

      float mean8=0, std8=0, cv8=0;
      calcCv8(mean8, std8, cv8);
      gCv8 = cv8;

      bool humCand  = (rms1s >= ENV_RMS_MIN) && (cv8 <= ENV_CV8_HUM_ON)  && (hfr <= ENV_HFR_HUM_MAX);
      bool mechCand = (rms1s >= ENV_RMS_MIN) && (cv8 <= ENV_CV8_MECH_ON) && (hfr >= ENV_HFR_MECH_MIN);
      bool envCand = humCand || mechCand;

      bool humBreak  = (cv8 >= ENV_CV8_HUM_OFF)  || (rms1s < ENV_RMS_MIN * 0.7f);
      bool mechBreak = (cv8 >= ENV_CV8_MECH_OFF) || (rms1s < ENV_RMS_MIN * 0.7f);

      bool envBreak = false;
      if (envActive) {
        if (envMode == 1) envBreak = humBreak;
        else if (envMode == 2) envBreak = mechBreak;
        else envBreak = (cv8 > 0.12f);
      }

      if (!envActive) {
        if (envCand) { if (envOnStreak < 250) envOnStreak++; }
        else envOnStreak = 0;

        if (envOnStreak >= ENV_ON_SEC) {
          envActive = 1;
          envOffStreak = 0;
          envMode = humCand ? 1 : 2;
        }
      } else {
        if (envBreak) { if (envOffStreak < 250) envOffStreak++; }
        else envOffStreak = 0;

        if (envOffStreak >= ENV_OFF_SEC) {
          envActive = 0;
          envMode = 0;
          envOnStreak = 0;
        }
      }

      gEnvNoise = envActive;
      gEnvMode  = envMode;

      if (noiseFloor < 0.0005f) noiseFloor = 0.0005f;
      if (envActive) noiseFloor = 0.995f * noiseFloor + 0.005f * rms1s;
      else {
        if (fabsf(z) < 1.2f && rms1s < 0.020f) noiseFloor = 0.98f * noiseFloor + 0.02f * rms1s;
      }
      if (noiseFloor < 0.0005f) noiseFloor = 0.0005f;
      gNoiseFloorRms = noiseFloor;

      int rawSn = 0;
      if (!envActive) {
        if (rms1s > SNORE_RMS_MIN && p2p > SNORE_P2P_MIN) rawSn = 1;
      }
      if (rawSn) { if (snoreStreak < 255) snoreStreak++; }
      else snoreStreak = 0;

      int sn = (snoreStreak >= 2) ? 1 : 0;
      gSnore = (uint8_t)sn;

      uint8_t old = snoreRing[snoreIdx];
      snoreRing[snoreIdx] = (uint8_t)sn;
      snoreIdx = (snoreIdx + 1) % 10;
      int sc = (int)snoreCnt + (sn ? 1 : 0) - (old ? 1 : 0);
      if (sc < 0) sc = 0;
      if (sc > 10) sc = 10;
      snoreCnt = (uint8_t)sc;
      gSnoreWin10 = snoreCnt;

      int snAbn = 0;
      if (sn) {
        if (!abnActive) {
          if (z > 3.2f && rms1s > 0.018f) abnActive = true;
        } else {
          if (z < 1.8f || rms1s < (0.018f * 0.6f)) abnActive = false;
        }
        snAbn = abnActive ? 1 : 0;
      } else {
        abnActive = false;
        snAbn = 0;
      }

      static uint8_t snAbnStreak2 = 0;
      if (snAbn) { if (snAbnStreak2 < 255) snAbnStreak2++; }
      else snAbnStreak2 = 0;

      gSnoreAbn = (snAbnStreak2 >= 2) ? 1 : 0;

      const bool markReq = (gMarkSegAbnReq != 0);
      if (gSnoreAbn) segMarkedAbn = true;
      if (markReq) { segMarkedAbn = true; gMarkSegAbnReq = 0; }

      if ((gSnoreAbn || markReq || gAlarmA) && (segFirstAbnTs == 0)) {
        segFirstAbnTs = nowEpoch();
      }

      // Per-second SpO2 row (align to segment second index)
      uint32_t secIdx = (uint32_t)(segSamplesWritten / (uint32_t)AUDIO_FS);
      if (secIdx > 0) secIdx--;
      if (secIdx < (uint32_t)SEG_SECONDS && secIdx != segLastLoggedSec) {
        segLastLoggedSec = secIdx;
        int16_t spo2i = -1;
        if (gFinger && gPPG_OK) spo2i = (int16_t)lroundf(gSpO2);
        segSpo2Log[secIdx] = spo2i;
        segSpo2AbnLog[secIdx] = (uint8_t)((gSnoreAbn || markReq || gAlarmA) ? 1 : 0);
      }

      if (DBG_AUDIO) {
        Serial.printf("[AUDIO] fastRMS=%.5f p2pF=%ld | rms1s=%.5f z=%.2f cv8=%.3f hfr=%.2f p2p=%ld env=%d mode=%d nf=%.5f sn=%d snAbn=%d\n",
          (double)gAudioRmsFast, (long)gAudioP2PFast,
          (double)rms1s, (double)z, (double)cv8, (double)hfr, (long)p2p,
          (int)envActive, (int)envMode, (double)noiseFloor, (int)gSnore, (int)gSnoreAbn
        );
      }

      nS = 0;
      sumSqS = 0.0;
      diffSqS = 0.0;
      zcS = 0;
      minS = 32767;
      maxS = -32768;
    }
  }
}

//  OSA FSM + BUZZER TASK 
enum SystemState { MONITORING, WAITING_CONFIRM, ALARM_TRIGGER };
static void taskHealth(void* pv) {
  Serial.printf("[Core%d] taskHealth start\n", xPortGetCoreID());

  SystemState st = MONITORING;

  uint32_t silenceStartMs = 0;
  float baselineSpO2Evt = -1.0f;

  bool preWarnActive = false;
  uint8_t preWarnBeepCount = 0;
  uint32_t preWarnNextToggleMs = 0;
  bool preWarnToneOn = false;
  uint32_t ignoreBreathUntilMs = 0;

  uint32_t alarmCycleStartMs = 0;

  auto getAudioThr = [&]() -> float {
    float nf = gNoiseFloorRms;
    float thr = fmaxf(AUDIO_THRESHOLD_MIN, AUDIO_K_THR * nf);
    if (gEnvNoise) thr = fmaxf(thr, 1.10f * AUDIO_K_THR * nf);
    return thr;
  };
  auto stopAllBeep = [&]() {
    buzzerOff();
    preWarnActive = false;
    preWarnBeepCount = 0;
    preWarnToneOn = false;
  };

  for (;;) {
    uint32_t ms = millis();
    bool valid = (gFinger == 1) && (gPPG_OK == 1) && (gSpO2 >= MIN_VALID_SPO2);
    if (!valid) {
      st = MONITORING;
      silenceStartMs = 0;
      baselineSpO2Evt = -1.0f;
      ignoreBreathUntilMs = 0;
      gAlarmA = 0;
      stopAllBeep();
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    if (st == MONITORING) {
      float spo2 = gSpO2;
      if (gSpO2Base < 0) gSpO2Base = spo2;
      if (spo2 >= 93.0f && spo2 <= 99.5f) gSpO2Base = 0.995f * gSpO2Base + 0.005f * spo2;
    }

    float audio = gAudioRmsFast;
    float thr = getAudioThr();
    float thrEnter = thr * AUDIO_HYS_DOWN;
    float thrExit  = thr * AUDIO_HYS_UP;

    bool canCancelByAudio = (ms >= ignoreBreathUntilMs) && (!preWarnActive);
    bool isSilent = (audio < thrEnter);
    bool isBreath = (audio > thrExit);

    // pre-warning beep (3 beeps)
    if (preWarnActive) {
      if (ms >= preWarnNextToggleMs) {
        preWarnNextToggleMs = ms + 200;
        preWarnToneOn = !preWarnToneOn;
        if (preWarnToneOn) buzzerOn();
        else {
          buzzerOff();
          preWarnBeepCount++;
          if (preWarnBeepCount >= 3) {
            preWarnActive = false;
            preWarnBeepCount = 0;
            preWarnToneOn = false;
            buzzerOff();
            ignoreBreathUntilMs = ms + 5000;
          }
        }
      }
    }

    switch (st) {
      case MONITORING: {
        gAlarmA = 0;
        stopAllBeep();
        ignoreBreathUntilMs = 0;

        if (isSilent) {
          silenceStartMs = ms;
          baselineSpO2Evt = gSpO2;
          st = WAITING_CONFIRM;
          if (DBG_FSM) Serial.println("[FSM] MONITORING -> WAITING_CONFIRM (silence start)");
        }
      } break;

      case WAITING_CONFIRM: {
        uint32_t dur = (silenceStartMs ? (ms - silenceStartMs) : 0);
        if (canCancelByAudio && isBreath) {
          st = MONITORING;
          silenceStartMs = 0;
          baselineSpO2Evt = -1.0f;
          preWarnActive = false;
          buzzerOff();
          if (DBG_FSM) Serial.println("[FSM] WAITING_CONFIRM -> MONITORING (breath back)");
          break;
        }

        if (dur >= TIME_APNEA_LIMIT_MS && !preWarnActive) {
          if (ignoreBreathUntilMs == 0) {
            preWarnActive = true;
            preWarnBeepCount = 0;
            preWarnToneOn = false;
            preWarnNextToggleMs = ms;
            if (DBG_FSM) Serial.println("[FSM] PreWarn: 3 beeps (suspect apnea)");
          }
        }

        float drop = (baselineSpO2Evt > 0 ? (baselineSpO2Evt - gSpO2) : 0.0f);
        if (dur > TIME_APNEA_LIMIT_MS && drop >= SPO2_DROP_PERCENT) {
          st = ALARM_TRIGGER;
          gAlarmA = 1;
          gMarkSegAbnReq = 1; 
          stopAllBeep();
          alarmCycleStartMs = ms;
          if (DBG_FSM) Serial.printf("[FSM] CONFIRMED! drop=%.1f -> ALARM_TRIGGER\n", (double)drop);
        }
      } break;

      case ALARM_TRIGGER: {
        gAlarmA = 1;
        uint32_t t = ms - alarmCycleStartMs;
        bool inBeepPhase = (t < 5000);
        bool inProbePhase = (t >= 5000 && t < 7000);
        if (t >= 7000) {
          alarmCycleStartMs = ms;
          t = 0;
          inBeepPhase = true;
          inProbePhase = false;
        }

        if (inBeepPhase) {
          static uint32_t lastTog = 0;
          static bool ph = false;
          if (ms - lastTog >= 200) {
            lastTog = ms;
            ph = !ph;
            if (ph) buzzerOn();
            else buzzerOff();
          }
        } else {
          buzzerOff();
        }

        bool spo2Recovered = (baselineSpO2Evt > 0) && (gSpO2 >= (baselineSpO2Evt - 1.0f));
        bool audioRecovery = (audio > (thrExit * 2.0f));

        if (inProbePhase) {
          if (audioRecovery || spo2Recovered) {
            buzzerOff();
            st = MONITORING;
            gAlarmA = 0;
            silenceStartMs = 0;
            baselineSpO2Evt = -1.0f;
            ignoreBreathUntilMs = 0;
            if (DBG_FSM) Serial.printf("[FSM] ALARM -> MONITORING (recover: audio=%d spo2Rec=%d)\n",
              (int)audioRecovery, (int)spo2Recovered);
          }
        }
      } break;
    }

    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

//  UPLOADER TASK
static void taskUploader(void* pv) {
  Serial.printf("[Core%d] taskUploader start\n", xPortGetCoreID());
  vTaskDelay(pdMS_TO_TICKS(2000));
  uint32_t lastTelem = millis();

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      static uint32_t lastRe = 0;
      uint32_t ms = millis();
      if (ms - lastRe > 3000) {
        lastRe = ms;
        WiFi.reconnect();
      }
    }

    uint32_t now = millis();
    if (now - lastTelem >= 1000) {
      lastTelem = now;

      uint32_t ts = nowEpoch();
      String body;
      body.reserve(128);
      body += "{";
      body += "\"ts\":" + String((unsigned long)ts) + ",";
      if (gPPG_OK == 1 && gSpO2 > 0) body += "\"spo2\":" + String((double)gSpO2, 1) + ",";
      else body += "\"spo2\":null,";
      if (gAudioRms1s > 0) body += "\"rms\":" + String((double)gAudioRms1s, 5) + ",";
      else body += "\"rms\":null,";
      body += "\"alarmA\":" + String(gAlarmA);
      body += "}";

      int code = 0;
      bool ok = httpsPostJson(API_TELEM_PATH, body, &code);
      if (!ok) {
        Serial.printf("[UP] telemetry FAIL http=%d\n", code);
      }
    }

    //  Abnormal mark: upload filename only
    if (gMarkQ) {
      MarkJob j{};
      if (xQueueReceive(gMarkQ, &j, pdMS_TO_TICKS(10)) == pdTRUE) {
        if (WiFi.status() == WL_CONNECTED) {
          char body[200];
          snprintf(body, sizeof(body),
                   "{\"ts\":%lu,\"filename\":\"%s\"}",
                   (unsigned long)j.ts, j.filename);
          int code = 0;
          bool ok = httpsPostJson(API_ABN_MARK_PATH, body, &code);
          Serial.printf("[UP] mark %s -> %s (http=%d)\n",
                        j.filename, ok ? "OK" : "FAIL", code);
        }
      }
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// SETUP / LOOP
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_BUZZER, OUTPUT);
  buzzerOff();

  Serial.println("Boot.");
  Serial.printf("[PINS] I2C(SDA=%d,SCL=%d) I2S(BCLK=%d,WS=%d,SD=%d) SD(SCK=%d,MISO=%d,MOSI=%d,CS=%d) BUZZ=%d\n",
                PIN_I2C_SDA, PIN_I2C_SCL,
                PIN_I2S_BCLK, PIN_I2S_WS, PIN_I2S_SD,
                PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, PIN_SD_CS,
                PIN_BUZZER);

  Serial.print("WiFi connecting");
  wifiConnect();

  Serial.print("Sync time (GMT+7 Hanoi)");
  bool tsOk = timeSync();
  Serial.println();
  Serial.println(tsOk ? "Time synced." : "Time sync FAIL (still running).");
  Serial.printf("Free heap=%u\n", ESP.getFreeHeap());

  initMAX30102();

  bool i2sOk = initI2S();
  if (!i2sOk) Serial.println("I2S init FAIL.");

  gSdOk = sdInit();

  gSdMutex = xSemaphoreCreateMutex();
  if (!gSdMutex) Serial.println("[SD] WARN: failed to create SD mutex");

  gMarkQ = xQueueCreate(16, sizeof(MarkJob));
  gSpo2Q = xQueueCreate(8, sizeof(Spo2Job));

  if (i2sOk) xTaskCreatePinnedToCore(taskAudio, "taskAudio", 8192, nullptr, 2, nullptr, 1);
  xTaskCreatePinnedToCore(taskPPG, "taskPPG", 8192, nullptr, 1, nullptr, 0);
  xTaskCreatePinnedToCore(taskHealth, "taskHealth", 4096, nullptr, 2, nullptr, 0);
  xTaskCreatePinnedToCore(taskUploader, "taskUploader", 24576, nullptr, 1, nullptr, 0);

  xTaskCreatePinnedToCore(taskSDWorker, "taskSDWorker", 8192, nullptr, 1, nullptr, 0);

  Serial.println("Setup done.");
}

void loop() {
  delay(1000);
}
