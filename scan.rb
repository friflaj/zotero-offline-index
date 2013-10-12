#!/usr/bin/env ruby

require 'json'
require 'yaml'
require 'zip/zipfilesystem'
require 'tempfile'
require 'pp'
require 'redcarpet'
require 'nokogiri'
require 'trollop'
require 'net/http'
require 'nokogiri'
require 'rubygems/package'
require 'csv'

TIKA = Net::HTTP.new('localhost', 9998)

OPTS = Trollop::options do
  opt :reset, "Re-scan entire library"
end

class Scanner
  EXT = '.offline.txt'
  EXT2MIMETYPE = {
    '.epub' => 'application/epub+zip',
    '.mobi' => 'application/x-mobipocket-ebook',
    '.pdf'  => 'application/pdf',
    '.doc'  => 'application/msword',
    '.docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }

  def tika(stream, mimetype, size)
    req = Net::HTTP::Put.new('/all')
    req.body_stream = stream
    req["Content-Type"] = mimetype
    req.add_field('Content-Length', size)
    req.add_field('Accept', 'application/x-tar')
    res = TIKA.request(req)
    
    data = {html: ''}

    tar_extract = Gem::Package::TarReader.new(StringIO.new(res.body))
    tar_extract.rewind
    tar_extract.each do |entry|
      next unless entry.file?
      case entry.full_name
      when '__TEXT__'
        data[:html] = entry.read
      when '__METADATA__'
        data[:metadata] = {}
        CSV.parse(entry.read, :col_sep => ',').each{|row|
          data[:metadata][row[0]] = row[1]
        }
      end
    end
    tar_extract.close

    return data
  end

  def text2words(text)
    text = text.strip.split(/[^[:alpha:]]+/)
    text = text.collect{|w| w.downcase}.uniq.reject{|w| w.length < 2}
    chars = 0
    return Hash[*(text.collect{|w| l = w.length; chars += l; [w, l]}.flatten)]
  end

  def initialize(root)
    if OPTS[:reset]
      Dir[File.join(root, ".*#{EXT}")].each{|f| File.unlink(f)}
      exit
    end

    extensions = []
    hashes = {}
    errors = []
    Dir[File.join(root, '*.zip')].sort.each{|zipfile|
      key = File.basename(zipfile, File.extname(zipfile)).upcase
      cachefile = File.join(File.dirname(zipfile), ".#{key}#{EXT}")
      next if File.exists?(cachefile) && File.mtime(cachefile) > File.mtime(zipfile)


      propfile = File.join(File.dirname(zipfile), File.basename(zipfile, File.extname(zipfile)) + '.prop')
      hash = nil
      File.open(propfile){|f| hash = Nokogiri::XML(f).xpath('/properties/hash').inner_text }
      hash = nil if hash == ''
      hashes[key] = hash if hash

      data = {text: ''}

      File.unlink(cachefile) if File.exists?(cachefile)

      puts zipfile
      Zip::ZipFile.foreach(zipfile) {|entry|
        next unless entry.file?

        ext = File.extname(entry.to_s.downcase)

        case ext
        when '.txt'
          data = {text: entry.get_input_stream.read}
        when '.html'
          data[:text] += ' ' + Nokogiri::HTML(entry.get_input_stream.read).inner_text
        when '.epub'
          # Tika doesn't always pick up epub contents
          Tempfile.open('epub') do |f|
            entry.extract(f.path){true}
            Zip::ZipFile.foreach(f.path){|chapter|
              next unless chapter.file?
              next unless chapter.to_s.downcase =~ /\.x?html?$/ || (chapter.to_s.downcase =~ /oebps\/text/ && chapter.to_s.downcase =~ /\.xml$/)
              data[:text] += ' ' +  Nokogiri::HTML(chapter.get_input_stream.read).inner_text
            }
          end
        when '.pdf', '.mobi', '.doc', '.docx'
          raise "No mimetype for #{ext}" unless EXT2MIMETYPE[ext]
          data = tika(entry.get_input_stream, EXT2MIMETYPE[ext], entry.size)
          data[:text] = Nokogiri::HTML(data.delete(:html) || '').inner_text
        else
          extensions << File.extname(entry.to_s.downcase)
        end
      }

      if data[:text].to_s.strip == ''
        errors << zipfile
        next
      end

      data[:chars] = data[:text].length
      data[:words] = text2words(data.delete(:text))
      data[:pages] = data[:metadata]['xmpTPg:NPages'] if data[:metadata] && data[:metadata]['xmpTPg:NPages']
      data.delete(:metadata)

      File.open(cachefile, "wb", :encoding => 'utf-8'){|f| f.write(data.to_json) } if data[:words].size > 0
    }

    File.open(File.join(root, EXT), "wb", :encoding => 'utf-8'){|f| f.write(hashes.to_json) }
    File.open(File.join(root, EXT + '.error'), "wb", :encoding => 'utf-8'){|f| f.write(errors.to_yaml) }
  end
end

Scanner.new('/var/www/webdav/emile/zotero/')
