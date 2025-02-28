import customtkinter as ctk
from tkinter import filedialog, messagebox
import shutil
import os
import json
from datetime import datetime

# Config file to store folder paths
CONFIG_FILE = "config.json"
RESTORED_BACKUP_FOLDER = "Restored Backups"

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

    # Get backup folder with timestamp
    date_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    backup_path = os.path.join(destination, date_str)
    os.makedirs(backup_path, exist_ok=True)

    # Ask for a backup note
    note = ctk.CTkInputDialog(text="Enter a note for this backup:", title="Backup Note").get_input()
    if note:
        with open(os.path.join(backup_path, "backup-note.txt"), "w") as note_file:
            note_file.write(note)

    # Copy save files
    for file_name in os.listdir(source):
        file_path = os.path.join(source, file_name)
        if os.path.isfile(file_path):
            shutil.copy(file_path, backup_path)

    messagebox.showinfo("Success", f"Saves backed up to {backup_path}")

# Restore Saves
def restore_saves():
    destination = save_folder.get()
    source = backup_folder.get()

    if not os.path.exists(destination) or not os.path.exists(source):
        messagebox.showerror("Error", "Please select valid folder paths before restoring.")
        return

    # Get list of backups
    backups = sorted([f for f in os.listdir(source) if os.path.isdir(os.path.join(source, f))], reverse=True)

    if not backups:
        messagebox.showerror("Error", "No backups found!")
        return

    # Create selection window
    restore_window = ctk.CTkToplevel(root)
    restore_window.title("Select a Backup to Restore")
    restore_window.geometry("400x400")

    from tkinter import Listbox  # Add this at the top with other imports

    backup_listbox = Listbox(restore_window, height=10)

    for backup in backups:
        backup_path = os.path.join(source, backup)
        note_path = os.path.join(backup_path, "backup-note.txt")
        note_text = ""

        if os.path.exists(note_path):
            with open(note_path, "r") as note_file:
                note_text = note_file.read().strip()

        backup_listbox.insert("end", f"{backup} - {note_text}")


    backup_listbox.pack(pady=10, padx=10, fill="both", expand=True)

    def restore_selected():
        selected_index = backup_listbox.curselection()
        if not selected_index:
            messagebox.showerror("Error", "Please select a backup to restore.")
            return

        selected_backup = backups[selected_index[0]]
        latest_backup_path = os.path.join(source, selected_backup)

        # Move current save files instead of deleting them
        restored_backup_path = os.path.join(source, RESTORED_BACKUP_FOLDER, f"Restored_Backup_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}")
        os.makedirs(restored_backup_path, exist_ok=True)
        for file_name in os.listdir(destination):
            file_path = os.path.join(destination, file_name)
            if os.path.isfile(file_path):
                shutil.move(file_path, restored_backup_path)

        # Copy new save files
        for file_name in os.listdir(latest_backup_path):
            file_path = os.path.join(latest_backup_path, file_name)
            if os.path.isfile(file_path) and not file_name.endswith("backup-note.txt"):
                shutil.copy(file_path, destination)

        messagebox.showinfo("Success", f"Saves restored from {selected_backup}")

        restore_window.destroy()

    restore_button = ctk.CTkButton(restore_window, text="Restore Selected", command=restore_selected)
    restore_button.pack(pady=10)

    restore_window.mainloop()

# Load Config
config = load_config()

# GUI Setup
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("green")

root = ctk.CTk()
root.title("Sims 4 Save Manager")
root.geometry("450x300")
root.iconbitmap("SimsSaveIcon.ico")  # Set the application icon

# Folder Variables
save_folder = ctk.StringVar(value=config["save_folder"])
backup_folder = ctk.StringVar(value=config["backup_folder"])

# UI Elements
ctk.CTkLabel(root, text="Save Folder:").pack(pady=5)
ctk.CTkEntry(root, textvariable=save_folder, width=350).pack()
ctk.CTkButton(root, text="Browse", command=select_save_folder).pack(pady=5)

ctk.CTkLabel(root, text="Backup Folder:").pack(pady=5)
ctk.CTkEntry(root, textvariable=backup_folder, width=350).pack()
ctk.CTkButton(root, text="Browse", command=select_backup_folder).pack(pady=5)

# Backup & Restore Buttons
ctk.CTkButton(root, text="Backup Saves", command=backup_saves, width=200).pack(pady=10)
ctk.CTkButton(root, text="Restore Saves", command=restore_saves, width=200).pack()

root.mainloop()
