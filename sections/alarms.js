const St           = imports.gi.St;
const Gio          = imports.gi.Gio
const Gtk          = imports.gi.Gtk;
const GLib         = imports.gi.GLib;
const Meta         = imports.gi.Meta;
const Shell        = imports.gi.Shell;
const Pango        = imports.gi.Pango;
const GnomeDesktop = imports.gi.GnomeDesktop;
const Clutter      = imports.gi.Clutter;
const Main         = imports.ui.main;
const CheckBox     = imports.ui.checkBox;
const PopupMenu    = imports.ui.popupMenu;
const MessageTray  = imports.ui.messageTray;
const Signals      = imports.signals;
const Mainloop     = imports.mainloop;


const ME = imports.misc.extensionUtils.getCurrentExtension();


const Gettext  = imports.gettext.domain(ME.metadata['gettext-domain']);
const _        = Gettext.gettext;
const ngettext = Gettext.ngettext;


const SOUND_PLAYER    = ME.imports.lib.sound_player;
const SIG_MANAGER     = ME.imports.lib.signal_manager;
const KEY_MANAGER     = ME.imports.lib.keybinding_manager;
const PANEL_ITEM      = ME.imports.lib.panel_item;
const MULTIL_ENTRY    = ME.imports.lib.multiline_entry;
const NUM_PICKER      = ME.imports.lib.num_picker;
const DAY_CHOOSER     = ME.imports.lib.day_chooser;
const MISC_UTILS      = ME.imports.lib.misc_utils;
const TEXT_LINKS_MNGR = ME.imports.lib.text_links_manager;
const REG             = ME.imports.lib.regex;


const CACHE_FILE = GLib.get_home_dir() +
                   '/.cache/timepp_gnome_shell_extension/timepp_alarms.json';


const NotifStyle = {
    STANDARD   : 0,
    FULLSCREEN : 1,
};



// =====================================================================
// @@@ Main
//
// @ext      : obj (main extension object)
// @settings : obj (extension settings)
// =====================================================================
var SectionMain = class extends ME.imports.sections.section_base.SectionBase {
    constructor (section_name, ext, settings) {
        super(section_name, ext, settings);

        this.actor = new St.BoxLayout({ vertical: true, style_class: 'section alarm-section' });
        this.panel_item.icon.icon_name = 'timepp-alarms-symbolic';
        this.panel_item.actor.add_style_class_name('alarm-panel-item');
        this.panel_item.set_mode('icon');

        this.separate_menu = this.settings.get_boolean('alarms-separate-menu');


        this.cache_file = null;
        this.cache      = null;
        this.css        = this.ext.custom_css;


        this.linkm = new TEXT_LINKS_MNGR.TextLinksManager(MISC_UTILS.split_on_whitespace);
        this.sigm  = new SIG_MANAGER.SignalManager();
        this.keym  = new KEY_MANAGER.KeybindingManager(this.settings);


        this.sound_player = new SOUND_PLAYER.SoundPlayer();


        this.fullscreen = new AlarmFullscreen(this.ext, this,
            this.settings.get_int('alarms-fullscreen-monitor-pos'));


        this.wallclock     = new GnomeDesktop.WallClock();
        this.wallclock_str = ''; // time_str


        try {
            this.cache_file = Gio.file_new_for_path(CACHE_FILE);

            let cache_format_version =
                ME.metadata['cache-file-format-version'].alarms;

            if (this.cache_file.query_exists(null)) {
                let [, contents] = this.cache_file.load_contents(null);
                this.cache = JSON.parse(contents);
            }

            if (!this.cache || !this.cache.format_version ||
                this.cache.format_version !== cache_format_version) {

                this.cache = {
                    format_version: cache_format_version,

                    // Array of alarm objects where each object is of the form:
                    // {
                    //     time_str     : string (a time_str)
                    //     msg          : string
                    //     days         : array (of ints; Sunday is 0)
                    //     toogle       : bool
                    //     snooze_dur   : int (minutes)
                    //     repeat_sound : bool
                    // }
                    alarms: [],
                };
            }
        }
        catch (e) {
            logError(e);
            return;
        }


        // AlarmItem objects
        this.alarm_items = new Set();


        // @key: alarm obj
        // @val: time_str
        this.snoozed_alarms = new Map();


        //
        // keybindings
        //
        this.keym.add('alarms-keybinding-open', () => {
             this.ext.open_menu(this.section_name);
        });


        //
        // add new alarm item
        //
        {
            this.header = new PopupMenu.PopupMenuItem('', { hover: false, activate: false, style_class: 'header' });
            this.actor.add_actor(this.header.actor);
            this.header.label.hide();
            this.header.actor.can_focus = false;

            this.add_alarm_button = new St.Button({ can_focus: true, x_align: St.Align.START, style_class: 'add-alarm' });
            this.header.actor.add(this.add_alarm_button, { expand: true });

            let box = new St.BoxLayout();
            this.add_alarm_button.add_actor(box);

            let icon = new St.Icon({ icon_name: 'timepp-plus-symbolic' });
            box.add_child(icon);

            let label = new St.Label({ text: _('Add New Alarm...'), y_align: Clutter.ActorAlign.CENTER });
            box.add_actor(label);
        }


        //
        // alarm items box
        //
        this.alarms_scroll_wrapper = new PopupMenu.PopupMenuItem('', { hover: false, activate: false });
        this.actor.add(this.alarms_scroll_wrapper.actor, {expand: true});
        this.alarms_scroll_wrapper.actor.hide();
        this.alarms_scroll_wrapper.label.hide();
        this.alarms_scroll_wrapper.actor.can_focus = false;

        this.alarms_scroll = new St.ScrollView({ style_class: 'alarms-container vfade', y_align: St.Align.START});
        this.alarms_scroll_wrapper.actor.add(this.alarms_scroll, {expand: true});

        this.alarms_scroll.vscrollbar_policy = Gtk.PolicyType.NEVER;
        this.alarms_scroll.hscrollbar_policy = Gtk.PolicyType.NEVER;

        this.alarms_scroll_content = new St.BoxLayout({ vertical: true, style_class: 'alarms-content-box' });
        this.alarms_scroll.add_actor(this.alarms_scroll_content);


        //
        // listen
        //
        this.sigm.connect(this.settings, 'changed::alarms-separate-menu', () => {
            this.separate_menu = this.settings.get_boolean('alarms-separate-menu');
            this.ext.update_panel_items();
        });
        this.sigm.connect(this.alarms_scroll_content, 'queue-redraw', () => {
            this.alarms_scroll.vscrollbar_policy = Gtk.PolicyType.NEVER;
            if (ext.needs_scrollbar())
                this.alarms_scroll.vscrollbar_policy = Gtk.PolicyType.ALWAYS;
        });
        this.sigm.connect(this.wallclock, 'notify::clock', () => this._tic());
        this.sigm.connect(this.fullscreen, 'monitor-changed', () => this.settings.set_int('alarms-fullscreen-monitor-pos', this.fullscreen.monitor));
        this.sigm.connect(this.panel_item, 'left-click', () => this.ext.toggle_menu(this.section_name));
        this.sigm.connect_press(this.add_alarm_button, Clutter.BUTTON_PRIMARY, true, () => this.alarm_editor());


        //
        // finally
        //
        this.cache.alarms.forEach((a) => this._add_alarm(a));
        this._update_panel_item_UI();
    }

    disable_section () {
        this.alarms_scroll_content.destroy_all_children();
        this.sigm.clear();
        this.keym.clear();
        this.snoozed_alarms.clear();

        if (this.fullscreen) {
            this.fullscreen.destroy();
            this.fullscreen = null;
        }

        super.disable_section();
    }

    _store_cache () {
        if (! this.cache_file.query_exists(null))
            this.cache_file.create(Gio.FileCreateFlags.NONE, null);

        this.cache_file.replace_contents(JSON.stringify(this.cache, null, 2),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    _tic () {
        let d    = GLib.DateTime.new_now(this.wallclock.timezone);
        let time = d.format('%H:%M');

        if (time === this.wallclock_str || d.get_seconds() > 1) return;

        this.wallclock_str = time;

        let today = new Date().getDay();

        for (let it of this.alarm_items) {
            let a = it.alarm;

            it.update_time_label();

            if (a.toggle && (a.time_str === time) && (a.days.indexOf(today) !== -1)) {
                this._send_notif(a);
            }
        }

        for (let [a, time_str] of this.snoozed_alarms) {
            if (a.toggle && time_str === time) {
                this._send_notif(a);
                this.snoozed_alarms.delete(a);
                for (let it of this.alarm_items) {
                    if (a === it.alarm) it.update_time_label();
                }
            }
        }

        this._update_panel_item_UI(today);
    }

    // @alarm_item: obj
    // If @alarm_item is not provided, then we are adding a new alarm.
    alarm_editor (alarm_item) {
        let alarm_obj = alarm_item ? alarm_item.alarm : null;
        let editor    = new AlarmEditor(this.ext, this, alarm_obj);

        this.actor.insert_child_at_index(editor.actor, 0);
        editor.button_cancel.grab_key_focus();
        this.header.actor.hide();
        this.alarms_scroll_wrapper.actor.hide();

        if (! alarm_item) {
            editor.connect('add-alarm', (_, alarm) => {
                this.cache.alarms.push(alarm);
                this._store_cache();
                this._add_alarm(alarm);

                this.header.actor.show();
                this.alarms_scroll_wrapper.actor.show();
                this.add_alarm_button.grab_key_focus();
                editor.actor.destroy();
            });
        }
        else {
            editor.connect('edited-alarm', (_, alarm) => {
                this.snoozed_alarms.delete(alarm);

                alarm_item.toggle.setToggleState(alarm.toggle);
                alarm_item.update_time_label();
                alarm_item.alarm_item_content.show();

                if (alarm.msg) {
                    alarm_item.set_body_text(alarm.msg);
                    alarm_item.msg.visible = true;
                }
                else {
                    alarm_item.msg.visible = false;
                }

                this._update_panel_item_UI();
                this.header.actor.show();
                this.alarms_scroll_wrapper.actor.show();
                this.add_alarm_button.grab_key_focus();
                editor.actor.destroy();

                this._store_cache();
            });

            editor.connect('delete-alarm', () => {
                this.header.actor.show();
                this.alarms_scroll_wrapper.actor.show();
                this.add_alarm_button.grab_key_focus();
                editor.actor.destroy();
                this.alarm_items.delete(alarm_item);
                alarm_item.actor.destroy();
                this._delete_alarm(alarm_item.alarm);
            });
        }

        editor.connect('cancel', () => {
            this.header.actor.show();
            this.add_alarm_button.grab_key_focus();
            editor.actor.destroy();

            if (this.alarms_scroll_content.get_n_children() > 0)
                this.alarms_scroll_wrapper.actor.show();
        });
    }

    // NOTE: This func assumes that @alarm has already been added to the
    // this.cache.alarms array.
    _add_alarm (alarm) {
        this._update_panel_item_UI();

        let alarm_item = new AlarmItem(this.ext, this, alarm);
        this.alarm_items.add(alarm_item);
        this.alarms_scroll_content.add_actor(alarm_item.actor);
        this.alarms_scroll_wrapper.actor.show();

        alarm_item.connect('alarm-toggled', () => {
            this.snoozed_alarms.delete(alarm);
            this._update_panel_item_UI();
            this._store_cache();
        });
    }

    _delete_alarm (alarm) {
        this.cache.alarms = this.cache.alarms.filter(a => a !== alarm);
        this.snoozed_alarms.delete(alarm);
        this._store_cache();
        this._update_panel_item_UI();

        if (this.alarms_scroll_content.get_n_children() === 0)
            this.alarms_scroll_wrapper.actor.hide();
    }

    snooze_alarm (alarm) {
        let t;

        t = GLib.DateTime.new_now(this.wallclock.timezone)
        t = t.add_minutes(alarm.snooze_dur);
        t = t.format('%H:%M');

        this.snoozed_alarms.set(alarm, t);

        for (let it of this.alarm_items) {
            if (it.alarm === alarm) it.update_time_label();
        }
    }

    _send_notif (alarm) {
        if (this.settings.get_boolean('alarms-play-sound')) {
            this.sound_player.set_sound_uri(this.settings.get_string('alarms-sound-file-path'));
            this.sound_player.play(alarm.repeat_sound);
        }

        if (this.settings.get_enum('alarms-notif-style') === NotifStyle.FULLSCREEN) {
            this.fullscreen.fire_alarm(alarm);
            return;
        }

        let source = new MessageTray.Source();
        Main.messageTray.add(source);
        source.connect('destroy', () => this.sound_player.stop());

        let icon = new St.Icon({ icon_name: 'timepp-alarms-symbolic' });

        // TRANSLATORS: %s is a time string in the format HH:MM (e.g., 13:44)
        let title = _('Alarm at %s').format(alarm.time_str);

        let params = {
            bannerMarkup : true,
            gicon        : icon.gicon,
        };

        let notif = new MessageTray.Notification(
            source,
            title,
            alarm.msg,
            params
        );

        notif.setUrgency(MessageTray.Urgency.CRITICAL);

        notif.addAction(`${_('Snooze')} (${alarm.snooze_dur} min)`, () => {
            this.snooze_alarm(alarm);
        });

        source.notify(notif);
    }

    _update_panel_item_UI (today = new Date().getDay()) {
        this.panel_item.actor.remove_style_class_name('on');

        for (let a of this.cache.alarms) {
            if (a.toggle && a.days.indexOf(today) !== -1) {
                this.panel_item.actor.add_style_class_name('on');
                break;
            }
        }
    }

    highlight_tokens (text) {
        text = MISC_UTILS.split_on_whitespace(
            MISC_UTILS.markdown_to_pango(text, this.ext.markdown_map));

        let token;

        for (let i = 0; i < text.length; i++) {
            token = text[i];

            if (REG.URL.test(token) || REG.FILE_PATH.test(token)) {
                text[i] =
                    '<span foreground="' + this.css['-timepp-link-color'][0] +
                    '"><u><b>' + token + '</b></u></span>';
            }
        }

        return text.join(' ').replace(/ *\r?\n */g, '\n');
    }
}; Signals.addSignalMethods(SectionMain.prototype);



// =====================================================================
// @@@ Alarm Editor
//
// @ext      : obj  (main ext object)
// @delegate : obj  (main section object)
// @alarm    : obj  (alarm object)
//
// @signals: 'add-alarm', 'edited-alarm', 'delete-alarm', 'cancel'
//
// If @alarm is given, it's time_str, days, msg, and snooze_dur props will be
// updated, and the alarm editor widget will be pre-populated with the alarms
// settings; otherwise, a complete new alarm object will be returned with the
// 'add-alarm' signal.
// =====================================================================
class AlarmEditor {
    constructor (ext, delegate, alarm) {
        this.ext      = ext;
        this.delegate = delegate;
        this.alarm    = alarm;


        //
        // container
        //
        this.actor = new St.Bin({ x_fill: true, style_class: 'view-box' });

        this.content_box = new St.BoxLayout({ x_expand: true, vertical: true, style_class: 'view-box-content'});
        this.actor.add_actor(this.content_box);


        //
        // alarm time
        //
        {
            let box = new St.BoxLayout({style_class: 'row numpicker-box'});
            this.content_box.add_actor(box);

            let label = new St.Label({ text: `${_('Alarm time')} ${_('(h:min)')} `, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
            box.add_child(label);

            this.hh = new NUM_PICKER.NumPicker(0, 23);
            box.add_child(this.hh.actor);

            this.mm = new NUM_PICKER.NumPicker(0, 59);
            box.add_child(this.mm.actor);

            if (alarm) {
                let [hr_str, min_str] = alarm.time_str.split(':');
                this.hh.set_counter(parseInt(hr_str));
                this.mm.set_counter(parseInt(min_str));
            }
        }


        //
        // choose day
        //
        this.day_chooser = new DAY_CHOOSER.DayChooser(alarm ? false : true);
        this.content_box.add_actor(this.day_chooser.actor);

        if (alarm) {
            alarm.days.forEach((day) => {
                let btn = this.day_chooser.buttons[day];
                btn.checked = true;
                btn.add_style_pseudo_class('active');
            });
        }


        //
        // snooze duration
        //
        {
            let box = new St.BoxLayout({style_class: 'row'});
            this.content_box.add_actor(box);

            let label = new St.Label({ text: `${_('Snooze duration')} ${_('(min)')} `, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
            box.add_child(label);

            this.snooze_duration_picker = new NUM_PICKER.NumPicker(1, null);
            box.add_child(this.snooze_duration_picker.actor);

            if (alarm)
                this.snooze_duration_picker.set_counter(alarm.snooze_dur);
        }


        //
        // repeat sound checkbox
        //
        this.checkbox_item = new St.BoxLayout({ reactive: true, x_expand: true, style_class: 'row' });
        this.content_box.add_actor(this.checkbox_item);

        this.checkbox_item.add_child(
            new St.Label({ text: _('Repeat notification sound?'), x_expand: true, y_align: Clutter.ActorAlign.CENTER }));

        this.sound_checkbox = new CheckBox.CheckBox();
        this.checkbox_item.add_child(this.sound_checkbox.actor);
        this.sound_checkbox.actor.checked = alarm && alarm.repeat_sound;


        //
        // entry
        //
        this.alarm_entry_container = new St.BoxLayout({ vertical: true, style_class: 'row entry-container' });
        this.content_box.add_actor(this.alarm_entry_container);
        this.entry = new MULTIL_ENTRY.MultiLineEntry(_('Alarm Message...'), true, false);

        this.entry.scroll_box.vscrollbar_policy = Gtk.PolicyType.NEVER;
        this.entry.scroll_box.hscrollbar_policy = Gtk.PolicyType.NEVER;

        this.alarm_entry_container.add_actor(this.entry.actor);

        if (alarm)
            this.entry.set_text(alarm.msg);


        //
        // buttons
        //
        let btn_box = new St.BoxLayout({ style_class: 'row btn-box' });
        this.content_box.add_actor(btn_box);

        if (alarm) {
            this.button_delete = new St.Button({ can_focus: true, label: _('Delete'), style_class: 'btn-delete button', x_expand: true });
            btn_box.add(this.button_delete, {expand: true});

            this.button_delete.connect('clicked', () => {
                this.emit('delete-alarm');
            });
        };

        this.button_cancel = new St.Button({ can_focus: true, label: _('Cancel'), style_class: 'btn-cancel button', x_expand: true });
        this.button_ok     = new St.Button({ can_focus: true, label: _('Ok'), style_class: 'btn-ok button', x_expand: true });
        btn_box.add(this.button_cancel, {expand: true });
        btn_box.add(this.button_ok, {expand: true});


        //
        // listen
        //
        this.button_ok.connect('clicked', () => {
            if (alarm) {
                alarm.time_str     = this._get_time_str(),
                alarm.msg          = this.entry.entry.get_text(),
                alarm.days         = this.day_chooser.get_days(),
                alarm.snooze_dur   = this.snooze_duration_picker.counter;
                alarm.repeat_sound = this.sound_checkbox.actor.checked;

                this.emit('edited-alarm', alarm);
            }
            else {
                this.emit('add-alarm', {
                    time_str     : this._get_time_str(),
                    msg          : this.entry.entry.get_text(),
                    days         : this.day_chooser.get_days(),
                    toggle       : true,
                    snooze_dur   : this.snooze_duration_picker.counter,
                    repeat_sound : this.sound_checkbox.actor.checked,
                });
            }
        });
        this.button_cancel.connect('clicked', () => {
            this.emit('cancel');
        });
        this.checkbox_item.connect('button-press-event', () => {
            this.sound_checkbox.actor.checked = !this.sound_checkbox.actor.checked;
        });
        this.entry.entry.connect('queue-redraw', () => {
            this.entry.scroll_box.vscrollbar_policy = Gtk.PolicyType.NEVER;

            if (this.ext.needs_scrollbar())
                this.entry.scroll_box.vscrollbar_policy = Gtk.PolicyType.ALWAYS;
        });
    }

    _get_time_str () {
        return this.hh.counter_label.get_text() + ':' +
               this.mm.counter_label.get_text();
    }
}; Signals.addSignalMethods(AlarmEditor.prototype);



// =====================================================================
// @@@ Alarm Item
//
// @ext      : obj (main extension object)
// @delegate : obj (main section object)
// @alarm    : obj (an alarm object)
//
// signals: 'alarm-toggled'
// =====================================================================
class AlarmItem {
    constructor (ext, delegate, alarm) {
        this.ext      = ext;
        this.delegate = delegate;
        this.alarm    = alarm;

        this.msg_vert_padding = -1;


        //
        // container
        //
        this.actor = new St.BoxLayout({ reactive: true, vertical: true, style_class: 'alarm-item menu-favorites-box' });

        this.alarm_item_content = new St.BoxLayout({vertical: true, style_class: 'alarm-item-content'});
        this.actor.add_actor(this.alarm_item_content);


        //
        // header
        //
        this.header = new St.BoxLayout({style_class: 'alarm-item-header'});
        this.alarm_item_content.add_actor(this.header);

        this.time = new St.Label({ y_align: St.Align.END, x_align: St.Align.START, style_class: 'alarm-item-time' });
        this.header.add(this.time, {expand: true});

        this.icon_box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER, style_class: 'icon-box'});
        this.header.add_actor(this.icon_box);

        this.edit_icon = new St.Icon({ visible: false, reactive: true, can_focus: true, track_hover: true, icon_name: 'timepp-edit-symbolic', style_class: 'settings-icon' });
        this.icon_box.add(this.edit_icon);

        this.toggle     = new PopupMenu.Switch(alarm.toggle);
        this.toggle_bin = new St.Button({can_focus: true, y_align: St.Align.START, x_align: St.Align.END });
        this.toggle_bin.add_actor(this.toggle.actor);
        this.icon_box.add(this.toggle_bin);


        //
        // body
        //
        this.msg = new St.Label({ y_align: St.Align.END, x_align: St.Align.START, style_class: 'alarm-item-message'});
        this.alarm_item_content.add_actor(this.msg);
        this.delegate.linkm.add_label_actor(this.msg, new Map([
            [REG.URL       , MISC_UTILS.open_web_uri],
            [REG.FILE_PATH , MISC_UTILS.open_file_path],
        ]));

        this.msg.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this.msg.clutter_text.set_single_line_mode(false);
        this.msg.clutter_text.set_line_wrap(true);
        this.msg.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);

        if (!alarm.msg) this.msg.hide();
        else this.set_body_text(alarm.msg);

        this.update_time_label();


        //
        // listen
        //
        this.toggle_bin.connect('clicked', () => this._on_toggle());
        this.delegate.sigm.connect_press(this.edit_icon, Clutter.BUTTON_PRIMARY, true, () => this._on_edit());
        this.ext.connect('custom-css-changed', () => this._on_custom_css_updated());
        this.actor.connect('queue-redraw', () => MISC_UTILS.resize_label(this.msg));
        this.actor.connect('enter-event',  () => this.edit_icon.show());
        this.actor.connect('event', (actor, event) => this._on_event(actor, event));
    }

    // @markup: string
    set_body_text (markup) {
        markup = GLib.markup_escape_text(markup, -1);
        markup = MISC_UTILS.markdown_to_pango(markup, this.ext.markdown_map);
        this.msg.clutter_text.set_markup(this.delegate.highlight_tokens(markup));
    }

    update_time_label () {
        let date   = new Date();
        let markup = `<b>${this.alarm.time_str}</b>`;

        // update clock ETA (time until alarm goes off)
        if (this.alarm.days.indexOf(date.getDay()) === -1) {
            markup += `  <b>${_('inactive today')}</b>`;

            if (this.alarm.toggle) this.actor.remove_style_class_name('active');
        } else if (this.alarm.toggle) {
            let clock_then;
            let clock_now;
            let snoozed_string = '';

            if (this.delegate.snoozed_alarms.has(this.alarm)) {
                clock_then     = this.delegate.snoozed_alarms.get(this.alarm);
                snoozed_string = `  <b>${_('Snoozed')}</b>`;
            } else {
                clock_then = this.alarm.time_str;
            }

            if (this.delegate.wallclock_str) {
                clock_now = this.delegate.wallclock_str;
            } else {
                clock_now = GLib.DateTime.new_now(this.delegate.wallclock.timezone);
                clock_now = clock_now.format('%H:%M');
            }

            if (clock_now >= clock_then) date.setDate(date.getDate() + 1);
            clock_then = clock_then.split(':');
            date.setHours(+(clock_then[0]));
            date.setMinutes(+(clock_then[1]));

            let delta = Math.floor((date.getTime() - Date.now()) / 1000);
            let h     = Math.floor(delta / 3600);
            let min   = Math.round(delta % 3600 / 60);

            markup += `  (${h}h ${min}min)${snoozed_string}`;

            if (this.alarm.toggle) this.actor.add_style_class_name('active');
        }

        this.time.clutter_text.set_markup(markup);
    }

    _on_toggle () {
        this.toggle.toggle();
        this.alarm.toggle = !this.alarm.toggle;

        if (this.alarm.days.indexOf(new Date().getDay()) !== -1) {
            if (this.alarm.toggle) this.actor.add_style_class_name('active');
            else                   this.actor.remove_style_class_name('active');
        }

        this.update_time_label();
        this.emit('alarm-toggled');
    }

    _on_edit () {
        Main.panel.menuManager.ignoreRelease();
        this.edit_icon.hide();
        this.delegate.alarm_editor(this);
    }

    _on_custom_css_updated () {
        for (let alarm_item of this.delegate.alarm_items) {
            alarm_item.set_body_text(alarm_item.alarm.msg);
        }
    }

    _on_event (actor, event) {
        switch (event.type()) {
            case Clutter.EventType.ENTER: {
                this.edit_icon.show();
                break;
            }

            case Clutter.EventType.LEAVE: {
                if (! this.header.contains(global.stage.get_key_focus()))
                    this.edit_icon.hide();
                break;
            }

            case Clutter.EventType.KEY_RELEASE: {
                this.edit_icon.show();
                MISC_UTILS.scroll_to_item(this.delegate.alarms_scroll,
                                          this.delegate.alarms_scroll_content,
                                          actor);
                break;
            }

            case Clutter.EventType.KEY_PRESS: {
                Mainloop.idle_add(() => {
                    if (! this.header.contains(global.stage.get_key_focus()))
                        this.edit_icon.hide();
                });
                break;
            }
        }
    }
}; Signals.addSignalMethods(AlarmItem.prototype);



// =====================================================================
// @@@ Alarm fullscreen interface
//
// @ext      : obj (main extension object)
// @delegate : obj (main section object)
// @monitor  : int
//
// signals: 'monitor-changed'
// =====================================================================
class AlarmFullscreen extends ME.imports.lib.fullscreen.Fullscreen {
    constructor (ext, delegate, monitor) {
        super(monitor);
        this.actor.add_style_class_name('alarm');

        this.ext      = ext;
        this.delegate = delegate;

        this.delegate.linkm.add_label_actor(this.banner, new Map([
            [REG.URL       , MISC_UTILS.open_web_uri],
            [REG.FILE_PATH , MISC_UTILS.open_file_path],
        ]));

        this.alarms = [];


        //
        // multi alarm view
        //
        this.alarm_cards_container = new St.BoxLayout({ vertical: true, x_expand: true, x_align: Clutter.ActorAlign.CENTER });
        this.middle_box.insert_child_at_index(this.alarm_cards_container, 0);

        this.alarm_cards_scroll = new St.ScrollView({ y_expand: true, style_class: 'vfade' });
        this.alarm_cards_container.add_actor(this.alarm_cards_scroll);

        this.alarm_cards_scroll.hscrollbar_policy = Gtk.PolicyType.NEVER;

        this.alarm_cards_scroll_bin = new St.BoxLayout({ y_expand: true, y_align: Clutter.ActorAlign.CENTER, vertical: true, style_class: 'alarm-cards-container'});
        this.alarm_cards_scroll.add_actor(this.alarm_cards_scroll_bin);


        //
        // title
        //
        this.title = new St.Label({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, style_class: 'main-title' });
        this.middle_box.insert_child_at_index(this.title, 0);


        //
        // snooze button
        //
        this.button_box = new St.BoxLayout({ x_expand: true, y_expand: true, style_class: 'btn-box', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, });
        this.bottom_box.add_child(this.button_box)
        this.button_snooze = new St.Button({ can_focus: true, style_class: 'button' });
        this.button_box.add_child(this.button_snooze);


        //
        // listen
        //
        this.button_snooze.connect('clicked', () => {
            if (this.alarms.length > 0)
                this.delegate.snooze_alarm(this.alarms[0]);

            this.close();
        });
    }

    set_banner_text (markup) {
        markup = GLib.markup_escape_text(markup, -1);
        super.set_banner_text(this.delegate.highlight_tokens(markup));
    }

    close () {
        this.delegate.sound_player.stop();
        this.alarms = [];
        this.alarm_cards_scroll_bin.destroy_all_children();
        super.close();
    }

    fire_alarm (alarm) {
        this.alarms.push(alarm);

        // TRANSLATORS: %s is a time string in the format HH:MM (e.g., 13:44)
        let title = _('Alarm at %s').format(alarm.time_str);
        let msg   = alarm.msg.trim();

        this._add_alarm_card(title, msg)

        if (this.alarms.length === 1) {
            this.bottom_box.show();
            this.button_snooze.label = `${_('Snooze')} (${alarm.snooze_dur} min)`;
            this.alarm_cards_container.hide();
            this.banner_container.show();

            if (msg) {
                this.title.text = title;
                this.set_banner_text(msg);
            }
            else {
                this.set_banner_text(title);
            }
        }
        else {
            this.bottom_box.hide();
            this.alarm_cards_container.show();
            this.banner_container.hide();
            this.title.text =
                ngettext('%d alarm went off!', '%d alarms went off!', this.alarms.length)
                .format(this.alarms.length);
        }

        this.open();
    }

    _add_alarm_card (title, msg) {
        let alarm_card = new St.BoxLayout({ vertical: true, style_class: 'alarm-card' });
        this.alarm_cards_scroll_bin.add_child(alarm_card);

        alarm_card.add_child(new St.Label({ text: title, style_class: 'title' }));

        let body;

        if (msg) {
            body = new St.Label({ y_align: St.Align.END, x_align: St.Align.START, style_class: 'body'});
            alarm_card.add_child(body);

            body.clutter_text.set_markup(this.delegate.highlight_tokens(msg));
            body.clutter_text.ellipsize        = Pango.EllipsizeMode.NONE;
            body.clutter_text.single_line_mode = false;
            body.clutter_text.line_wrap        = true;
            body.clutter_text.line_wrap_mode   = Pango.WrapMode.WORD_CHAR;

            this.delegate.linkm.add_label_actor(body, new Map([
                [REG.URL       , MISC_UTILS.open_web_uri],
                [REG.FILE_PATH , MISC_UTILS.open_file_path],
            ]));

            alarm_card.connect('queue-redraw', () => MISC_UTILS.resize_label(body));
        }
    }
}; Signals.addSignalMethods(AlarmFullscreen.prototype);
