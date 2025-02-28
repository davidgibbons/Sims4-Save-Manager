import tkinter as tk
from tkinter import filedialog, messagebox
import shutil
import os
import json
from datetime import datetime

# Config file to store folder paths
CONFIG_FILE = "config.json"

# Load saved folder paths
def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as file:
            return json.load(file)
    return {"save_folder": "", "backup_folder": ""}

# Save folder paths
def save_config():
    config_data = {"save_folder": save_folder.get(), "backup_folder": backup_folder.get()}
    with open(CONFIG_FILE, "w") as file:
        json.dump(config_data, file)

# Select Save Folder
def select_save_folder():
    folder = filedialog.askdirectory()
    if folder:
        save_folder.set(folder)
        save_config()

# Select Backup Folder
def select_backup_folder():
    folder = filedialog.askdirectory()
    if folder:
        backup_folder.set(folder)
        save_config()

# Backup Saves
def backup_saves():
    source = save_folder.get()
    destination = backup_folder.get()

    if not os.path.exists(source) or not os.path.exists(destination):
        messagebox.showerror("Error", "Please select valid folder paths before backing up.")
        return

    date_folder = os.path.join(destination, datetime.now().strftime("%Y-%m-%d"))
    os.makedirs(date_folder, exist_ok=True)

    for file_name in os.listdir(source):
        file_path = os.path.join(source, file_name)
        if os.path.isfile(file_path):
            shutil.copy(file_path, date_folder)

    messagebox.showinfo("Success", f"Saves backed up to {date_folder}")

# Restore Latest Backup
def restore_saves():
    destination = save_folder.get()
    source = backup_folder.get()

    if not os.path.exists(destination) or not os.path.exists(source):
        messagebox.showerror("Error", "Please select valid folder paths before restoring.")
        return

    # Find the most recent backup folder
    backup_folders = sorted([f for f in os.listdir(source) if os.path.isdir(os.path.join(source, f))], reverse=True)

    if not backup_folders:
        messagebox.showerror("Error", "No backups found!")
        return

    latest_backup = os.path.join(source, backup_folders[0])

    # Clear current save folder
    for file_name in os.listdir(destination):
        file_path = os.path.join(destination, file_name)
        if os.path.isfile(file_path):
            os.remove(file_path)

    # Copy latest backup files
    for file_name in os.listdir(latest_backup):
        shutil.copy(os.path.join(latest_backup, file_name), destination)

    messagebox.showinfo("Success", f"Saves restored from {latest_backup}")

# Load Config
config = load_config()

# GUI Setup
root = tk.Tk()
root.title("Sims 4 Save Manager")
root.geometry("400x250")
root.configure(bg="#74C365")  # Sims green

# Folder Variables
save_folder = tk.StringVar(value=config["save_folder"])
backup_folder = tk.StringVar(value=config["backup_folder"])

# Labels & Entry Fields
tk.Label(root, text="Save Folder:", bg="#74C365", fg="white").pack(pady=5)
tk.Entry(root, textvariable=save_folder, width=50).pack()
tk.Button(root, text="Browse", command=select_save_folder).pack(pady=5)

tk.Label(root, text="Backup Folder:", bg="#74C365", fg="white").pack(pady=5)
tk.Entry(root, textvariable=backup_folder, width=50).pack()
tk.Button(root, text="Browse", command=select_backup_folder).pack(pady=5)

# Buttons for Backup and Restore
tk.Button(root, text="Backup Saves", command=backup_saves, bg="white", fg="black", width=20).pack(pady=10)
tk.Button(root, text="Restore Last Backup", command=restore_saves, bg="white", fg="black", width=20).pack()

# Run GUI
root.mainloop()
