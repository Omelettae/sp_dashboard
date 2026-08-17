drop database if exists sensor_dashboard;
CREATE DATABASE sensor_dashboard;
USE sensor_dashboard;

-- Location table
CREATE TABLE Location (
    locationID INT AUTO_INCREMENT PRIMARY KEY,
    locationName VARCHAR(100) NOT NULL,
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    description VARCHAR(255),
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sensor List table
CREATE TABLE SensorType(
	typeID INT AUTO_INCREMENT PRIMARY KEY,
    sensorType VARCHAR(50)
);

-- Sensor table
CREATE TABLE Sensor (
    sensorID INT AUTO_INCREMENT PRIMARY KEY,

    typeID INT NOT NULL,
    locationID INT NOT NULL,

    deviceUUID CHAR(36) NOT NULL,

    sensorDescription TEXT NULL,

    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_sensor_type
        FOREIGN KEY (typeID)
        REFERENCES SensorType(typeID),

    CONSTRAINT fk_sensor_location
        FOREIGN KEY (locationID)
        REFERENCES Location(locationID),

    CONSTRAINT uq_sensor_identity
        UNIQUE (
            deviceUUID,
            typeID,
            locationID
        )
);

-- Sensor log table
CREATE TABLE SensorLog (
    logID BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT NOT NULL,
    datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    temperature DECIMAL(5,2),
    humidity DECIMAL(5,2),
    windspeed DECIMAL(5,2),
    windDirection INT,
    VPD DECIMAL(6,2),

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE
);

-- Device status table
CREATE TABLE DeviceStatus (
    sensorID INT PRIMARY KEY,

    batteryLevel DECIMAL(5,2),
    signalStrength INT,

    connectionStatus ENUM(
        'ONLINE',
        'OFFLINE',
        'UNKNOWN'
    ) DEFAULT 'UNKNOWN',

    lastHeartbeat TIMESTAMP NULL,

    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_device_status_sensor
        FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE
);

-- Error log table
CREATE TABLE ErrorLog (
    errorID BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT,
    errorType VARCHAR(50),
    errorMessage TEXT,
    severity ENUM('LOW','MEDIUM','HIGH','CRITICAL') DEFAULT 'LOW',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE SET NULL
);

-- Actuator table
CREATE TABLE Actuator (
    actuatorID INT AUTO_INCREMENT PRIMARY KEY,
    actuatorType VARCHAR(50),
    locationID INT,
    status ENUM('ON','OFF','IDLE') DEFAULT 'IDLE',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (locationID)
        REFERENCES Location(locationID)
        ON DELETE SET NULL
);

-- Actuator log table
CREATE TABLE ActuatorLog (
    actionID BIGINT AUTO_INCREMENT PRIMARY KEY,
    actuatorID INT,
    action ENUM('ON','OFF'),
    triggerSource ENUM('MANUAL','AUTOMATION','SYSTEM'),
    recordedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (actuatorID)
        REFERENCES Actuator(actuatorID)
        ON DELETE CASCADE
);

-- Climate rules table
CREATE TABLE ClimateRules (
    ruleID INT AUTO_INCREMENT PRIMARY KEY,
    parameter VARCHAR(50),
    thresholdValue DECIMAL(6,2),
    conditionType ENUM('GREATER','LESS'),
    actuatorID INT,
    action ENUM('ON','OFF'),

    FOREIGN KEY (actuatorID)
        REFERENCES Actuator(actuatorID)
        ON DELETE CASCADE
);
