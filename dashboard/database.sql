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

-- Sensor table
CREATE TABLE Sensor (
    sensorID INT AUTO_INCREMENT PRIMARY KEY,
    sensorType VARCHAR(50),
    locationID INT,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (locationID)
        REFERENCES Location(locationID)
        ON DELETE SET NULL
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
    statusID BIGINT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT NOT NULL,
    batteryLevel DECIMAL(5,2),
    signalStrength INT,
    lastHeartbeat TIMESTAMP,

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

INSERT INTO Location (locationName) VALUES
('Outside Dome'),
('Inside Dome'),
('Inside Box');

INSERT INTO Sensor (sensorType, locationID)
VALUES
('DHT22-D17-Pi5', (SELECT locationID FROM Location WHERE locationName='Outside Dome')),
('DHT22-D22', (SELECT locationID FROM Location WHERE locationName='Inside Dome')),
('DHT22-D27', (SELECT locationID FROM Location WHERE locationName='Inside Box')),
('5-in-one-sensor', (SELECT locationID FROM Location WHERE locationName='Outside Dome')),
('DHT22-D17-Pi4-1', (SELECT locationID FROM Location WHERE locationName='Inside Dome')),
('DHT22-D17-Pi4-2', (SELECT locationID FROM Location WHERE locationName='Inside Box'));
