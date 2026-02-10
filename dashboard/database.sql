drop database if exists sensor_dashboard;
CREATE DATABASE sensor_dashboard;
USE sensor_dashboard;

CREATE TABLE Sensor (
    sensorID INT AUTO_INCREMENT PRIMARY KEY,
    sensorType VARCHAR(50) NOT NULL,
    sensorLocation VARCHAR(50) NOT NULL
);

CREATE TABLE SensorLog (
    logID INT AUTO_INCREMENT PRIMARY KEY,
    sensorID INT NOT NULL,
    datetime DATETIME NOT NULL,
    temperature DECIMAL(5,2) NULL,
    humidity DECIMAL(5,2) NULL,
    windspeed DECIMAL(6,2) NULL,
    windDirection INT NULL,
    VPD DECIMAL(5,2) NULL,

    FOREIGN KEY (sensorID)
        REFERENCES Sensor(sensorID)
        ON DELETE CASCADE
);

INSERT INTO Sensor(sensorType, sensorLocation) VALUES
('DHT22-D17-Pi5', 'Outside Dome'),
('DHT22-D22', 'Inside Dome'),
('DHT22-D27', 'Inside Box'),
('5-in-one-sensor', 'Outside Dome'),
('DHT22-D17-Pi4-1', 'Inside Dome'),
('DHT22-D17-Pi4-2', 'Inside Box');
