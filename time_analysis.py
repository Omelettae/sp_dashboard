import pandas as pd
import matplotlib.pyplot as plt
import os


def time_series_analysis(filename):
    # =========================
    # 1. Load CSV
    # =========================
    if not os.path.exists(filename):
        print(f"File not found: {filename}")
        return

    df = pd.read_csv(filename)

    print("\nCSV loaded successfully.")
    print(f"Rows: {len(df)}")
    print(f"Columns: {list(df.columns)}")

    # =========================
    # 2. Clean column names
    # =========================
    df.columns = df.columns.str.strip()

    # =========================
    # 3. Convert datetime
    # =========================
    df["datetime"] = pd.to_datetime(
        df["datetime"],
        errors="coerce"
    )

    # Remove rows with invalid datetime
    df = df.dropna(subset=["datetime"])

    # Sort by sensor and time
    df = df.sort_values(["sensorID", "datetime"])

    # =========================
    # 4. Convert numeric columns
    # =========================
    numeric_columns = [
        "temperature",
        "humidity",
        "windspeed",
        "windDirection",
        "VPD"
    ]

    for column in numeric_columns:
        df[column] = pd.to_numeric(
            df[column],
            errors="coerce"
        )

    # =========================
    # 5. Basic information
    # =========================
    print("\n===== DATA INFORMATION =====")
    print(df.info())

    print("\n===== MISSING VALUES =====")
    print(df.isnull().sum())

    print("\n===== DATE RANGE =====")
    print(f"Start: {df['datetime'].min()}")
    print(f"End:   {df['datetime'].max()}")

    print("\n===== SENSOR IDs =====")
    print(df["sensorID"].unique())

    # =========================
    # 6. Analyze each sensor
    # =========================
    for sensor_id, sensor_df in df.groupby("sensorID"):

        print("\n" + "=" * 60)
        print(f"ANALYSIS FOR SENSOR {sensor_id}")
        print("=" * 60)

        sensor_df = sensor_df.copy()

        # Set datetime as index
        sensor_df = sensor_df.set_index("datetime")

        # Remove duplicate timestamps
        sensor_df = sensor_df[~sensor_df.index.duplicated(keep="first")]

        # =========================
        # 7. Descriptive statistics
        # =========================
        print("\n--- Descriptive Statistics ---")

        print(
            sensor_df[
                [
                    "temperature",
                    "humidity",
                    "windspeed",
                    "windDirection",
                    "VPD"
                ]
            ].describe()
        )

        # =========================
        # 8. Rolling mean
        # =========================
        # Adjust window depending on your data frequency.
        # Example: 24 observations
        # represents 24 readings, NOT necessarily 24 hours.
        window = 24

        for column in [
            "temperature",
            "humidity",
            "windspeed",
            "VPD"
        ]:
            sensor_df[f"{column}_rolling"] = (
                sensor_df[column]
                .rolling(window=window)
                .mean()
            )

        # =========================
        # 9. Plot sensor variables
        # =========================
        variables = [
            ("temperature", "Temperature"),
            ("humidity", "Humidity"),
            ("windspeed", "Wind Speed"),
            ("VPD", "VPD")
        ]

        for column, title in variables:

            plt.figure(figsize=(12, 5))

            plt.plot(
                sensor_df.index,
                sensor_df[column],
                label=title,
                alpha=0.5
            )

            plt.plot(
                sensor_df.index,
                sensor_df[f"{column}_rolling"],
                label=f"{title} - Rolling Mean",
                linewidth=2
            )

            plt.title(
                f"Sensor {sensor_id} - {title} Over Time"
            )

            plt.xlabel("Datetime")
            plt.ylabel(title)

            plt.legend()
            plt.grid(True)
            plt.tight_layout()

            plt.show()

        # =========================
        # 10. Wind direction
        # =========================
        plt.figure(figsize=(12, 5))

        plt.scatter(
            sensor_df.index,
            sensor_df["windDirection"],
            s=10
        )

        plt.title(
            f"Sensor {sensor_id} - Wind Direction Over Time"
        )

        plt.xlabel("Datetime")
        plt.ylabel("Wind Direction (degrees)")

        plt.grid(True)
        plt.tight_layout()

        plt.show()

        # =========================
        # 11. Correlation analysis
        # =========================
        print("\n--- Correlation Matrix ---")

        correlation = sensor_df[
            [
                "temperature",
                "humidity",
                "windspeed",
                "windDirection",
                "VPD"
            ]
        ].corr()

        print(correlation)

        # =========================
        # 12. Correlation heatmap
        # =========================
        plt.figure(figsize=(8, 6))

        plt.imshow(
            correlation,
            interpolation="nearest"
        )

        plt.colorbar()

        plt.xticks(
            range(len(correlation.columns)),
            correlation.columns,
            rotation=45
        )

        plt.yticks(
            range(len(correlation.columns)),
            correlation.columns
        )

        plt.title(
            f"Sensor {sensor_id} - Correlation Matrix"
        )

        plt.tight_layout()
        plt.show()


# =========================
# Main program
# =========================

if __name__ == "__main__":

    filename = input(
        "Enter CSV filename: "
    ).strip()

    time_series_analysis(filename)
    